import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  deriveOgFonts,
  missingFontFiles,
  resolveOgFonts,
  resolveOgFontSources,
} from "../src/og/derive.ts";

const ROOT = "/site";

describe("deriveOgFonts", () => {
  it("derives display and body families with the card's weights", () => {
    const { fonts, families } = deriveOgFonts(
      { body: "inter", display: "inter-tight", mono: "ibm-plex-mono" },
      ROOT
    );
    expect(fonts).toEqual([
      { name: "Inter Tight", weight: "400..700" },
      { name: "Inter", weight: "400..700" },
    ]);
    // The mono role never renders on a card.
    expect(fonts.some((font) => JSON.stringify(font).includes("Plex"))).toBe(
      false
    );
    expect(families).toEqual({ body: "Inter", title: "Inter Tight" });
  });

  it("dedupes when display and body share a family", () => {
    const { fonts } = deriveOgFonts({ body: "inter", display: "inter" }, ROOT);
    expect(fonts).toEqual([{ name: "Inter", weight: "400..700" }]);
  });

  it("fetches only the card's weights from a static family that declares them", () => {
    // Title 600 and body 400 are what the card renders; a static family
    // declaring more weights than that fetches just those two.
    const { fonts } = deriveOgFonts(
      { display: { name: "Static Sans", weights: [400, 600, 700] } },
      ROOT
    );
    expect(fonts).toEqual([{ name: "Static Sans", weight: [400, 600] }]);
  });

  it("falls back to declared weights when the card weights are absent", () => {
    // A static family declaring neither card weight (400/600) fetches the
    // weights it does declare — they're what its text renders in.
    const { fonts } = deriveOgFonts(
      { display: { name: "Static Serif", weights: [300, 800] } },
      ROOT
    );
    expect(fonts).toEqual([{ name: "Static Serif", weight: [300, 800] }]);
  });

  it("fetches a curated variable family by its range", () => {
    // Merriweather's curated range covers both card weights, so the one
    // variable file is fetched as-is.
    const { fonts } = deriveOgFonts({ display: "merriweather" }, ROOT);
    expect(fonts).toEqual([{ name: "Merriweather", weight: "400..700" }]);
  });

  it("passes a lone variable range through and keeps custom weights", () => {
    const { fonts } = deriveOgFonts(
      {
        body: { name: "Recursive", weights: ["300..900"] },
        display: { name: "Noto Sans JP", weights: [300, 900] },
      },
      ROOT
    );
    expect(fonts).toEqual([
      { name: "Noto Sans JP", weight: [300, 900] },
      { name: "Recursive", weight: "300..900" },
    ]);
  });

  it("skips non-Google remote providers but keeps the other role", () => {
    const { fonts, families } = deriveOgFonts(
      {
        body: "inter",
        display: { name: "Supreme", provider: "fontsource" },
      },
      ROOT
    );
    expect(fonts).toEqual([{ name: "Inter", weight: "400..700" }]);
    expect(families).toEqual({ body: "Inter" });
  });

  it("skips unknown slug strings entirely", () => {
    expect(deriveOgFonts({ display: "no-such-slug" }, ROOT)).toEqual({
      fonts: [],
    });
  });

  it("expands a local family into per-variant absolute entries", () => {
    const { fonts, families } = deriveOgFonts(
      {
        display: {
          name: "Custom Sans",
          variants: [
            { src: "./fonts/custom.woff2", weight: 600 },
            { src: "./fonts/custom-oblique.woff2", style: "oblique" },
          ],
        },
      },
      ROOT
    );
    expect(fonts).toEqual([
      { name: "Custom Sans", src: "/site/fonts/custom.woff2", weight: 600 },
      // Oblique isn't a card style; the face's own metadata wins.
      { name: "Custom Sans", src: "/site/fonts/custom-oblique.woff2" },
    ]);
    expect(families).toEqual({ title: "Custom Sans" });
  });

  it("carries a local face's normal or italic style onto its card entry", () => {
    const { fonts } = deriveOgFonts(
      {
        body: {
          name: "Custom Serif",
          variants: [
            { src: "/fonts/serif.woff2", style: "normal", weight: 400 },
            { src: "fonts/serif-italic.woff2", style: "italic", weight: 400 },
          ],
        },
      },
      ROOT
    );
    expect(fonts).toEqual([
      // An absolute source is kept as written.
      {
        name: "Custom Serif",
        src: "/fonts/serif.woff2",
        style: "normal",
        weight: 400,
      },
      {
        name: "Custom Serif",
        src: "/site/fonts/serif-italic.woff2",
        style: "italic",
        weight: 400,
      },
    ]);
  });

  it("derives nothing from an empty config", () => {
    expect(deriveOgFonts(undefined, ROOT)).toEqual({ fonts: [] });
    expect(deriveOgFonts({}, ROOT)).toEqual({ fonts: [] });
  });
});

describe("resolveOgFonts", () => {
  const themeFonts = { body: "inter", display: "geist" } as const;

  it("prefers explicit og fonts over derivation", () => {
    const resolved = resolveOgFonts(
      {
        ogFonts: ["Noto Sans JP"],
        themeFonts,
        themeFontsConfigured: true,
      },
      ROOT
    );
    expect(resolved).toEqual({ fonts: ["Noto Sans JP"] });
  });

  it("treats an explicit empty list as an opt-out", () => {
    const resolved = resolveOgFonts(
      { ogFonts: [], themeFonts, themeFontsConfigured: true },
      ROOT
    );
    expect(resolved).toEqual({ fonts: [] });
  });

  it("derives from configured theme fonts when og fonts are unset", () => {
    const resolved = resolveOgFonts(
      { ogFonts: undefined, themeFonts, themeFontsConfigured: true },
      ROOT
    );
    expect(resolved.fonts).toEqual([
      { name: "Geist", weight: "400..700" },
      { name: "Inter", weight: "400..700" },
    ]);
    expect(resolved.families).toEqual({ body: "Inter", title: "Geist" });
  });

  it("derives nothing from untouched theme defaults", () => {
    const resolved = resolveOgFonts(
      { ogFonts: undefined, themeFonts, themeFontsConfigured: false },
      ROOT
    );
    // Only the script fallbacks, which a card fetches on demand.
    expect(resolved.fonts).toEqual([]);
    expect(resolved.families).toEqual({ body: "Geist", title: "Geist" });
  });
});

describe("resolveOgFontSources", () => {
  it("makes local src paths absolute and leaves the rest alone", () => {
    expect(
      resolveOgFontSources(
        [
          "Noto Sans JP",
          { name: "Inter", weight: 700 },
          { name: "Custom", src: "./fonts/custom.woff2" },
          { name: "Rooted", src: "/already/abs.woff2" },
        ],
        ROOT
      )
    ).toEqual([
      "Noto Sans JP",
      { name: "Inter", weight: 700 },
      { name: "Custom", src: "/site/fonts/custom.woff2" },
      { name: "Rooted", src: "/already/abs.woff2" },
    ]);
  });
});

describe("missingFontFiles", () => {
  it("reports configured font files that do not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-fonts-"));
    await writeFile(join(root, "present.woff2"), "stub");
    const missing = missingFontFiles(
      {
        ogFonts: [
          "Noto Sans JP",
          { name: "Gone", src: "./gone.woff2" },
          { name: "Here", src: "./present.woff2" },
        ],
        themeFonts: {
          body: "inter",
          display: {
            name: "Custom",
            variants: [
              { src: "./present.woff2" },
              { src: "./missing-theme.woff2" },
            ],
          },
        },
      },
      root
    );
    expect(missing).toEqual([
      join(root, "missing-theme.woff2"),
      join(root, "gone.woff2"),
    ]);
  });

  it("reports nothing when no local fonts are configured", () => {
    expect(
      missingFontFiles(
        { ogFonts: ["Inter"], themeFonts: { body: "inter" } },
        ROOT
      )
    ).toEqual([]);
  });
});
