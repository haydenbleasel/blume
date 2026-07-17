import { describe, expect, it } from "bun:test";

import { renderOgImage } from "../src/og/card.ts";
import type { OgCardOptions } from "../src/og/card.ts";

const expectPng = async (options: OgCardOptions): Promise<void> => {
  const buffer = await renderOgImage(options);
  expect(buffer).toBeInstanceOf(Uint8Array);
  expect(buffer.length).toBeGreaterThan(0);
};

// A square logo whose viewBox aspect keeps the mark within MARK_MAX_WIDTH, and
// carries `currentColor` so logoMark's foreground repaint runs.
const SQUARE_LOGO =
  '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor" /></svg>';
// A wide wordmark: 400x40 → computed width 320 > MARK_MAX_WIDTH, forcing the
// down-scale branch.
const WIDE_LOGO =
  '<svg viewBox="0 0 400 40"><rect fill="currentColor" height="40" width="400" /></svg>';
// No viewBox → the aspect match is null and width falls back to MARK_HEIGHT.
const NO_VIEWBOX_LOGO =
  '<svg height="24" width="24"><path d="M0 0h24v24H0z" fill="currentColor" /></svg>';

const filledLogo = (fill: string): string =>
  `<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="${fill}" /></svg>`;

// Takumi's twemoji provider fetches each glyph SVG from a CDN. Stub it so emoji
// tests are hermetic — and immune to Bun's fetch keeping a once-seen HTTPS_PROXY
// for the rest of the process (the openapi proxy test would otherwise poison
// them). Returns the fetched URLs so a test can assert on the request count.
const withStubbedGlyphFetch = async (
  body: (urls: string[]) => Promise<void>
): Promise<void> => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="#e00"/></svg>',
        { headers: { "Content-Type": "image/svg+xml" } }
      )
    );
  }) as unknown as typeof fetch;
  try {
    await body(urls);
  } finally {
    globalThis.fetch = original;
  }
};

// 46 chars: past the 40-char threshold but within 60 (titleSize → 64).
const MEDIUM_TITLE = "Documentation for the Blume framework here now";
// Well past 60 chars (titleSize → 52).
const LONG_TITLE =
  "The complete guide to building fast markdown documentation sites with Blume";
// Past 140 chars so truncate trims it inside the body.
const LONG_DESCRIPTION =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud.";

describe("renderOgImage", () => {
  it("renders a minimal card (no logo, brand, description, or footer)", async () => {
    await expectPng({ title: "Hi" });
  });

  it("renders a brand lockup with the accent initial mark", async () => {
    await expectPng({ accent: "purple", brand: "Acme", title: "Short" });
  });

  it("renders an emoji-leading brand without splitting the surrogate pair", async () => {
    await withStubbedGlyphFetch(async () => {
      // `charAt(0)` used to emit a lone surrogate half, blanking the mark.
      await expectPng({ brand: "🚀 Rocket Docs", title: "Hi" });
    });
  });

  it("fetches a repeated emoji glyph once across renders", async () => {
    // One card is prerendered per page, so an emoji in the site title would
    // refetch the same glyph for every page without the shared cache. Uses an
    // emoji no other test renders, so the assertion counts only these renders.
    await withStubbedGlyphFetch(async (urls) => {
      await expectPng({ brand: "🦊 Fox Docs", title: "One" });
      await expectPng({ brand: "🦊 Fox Docs", title: "Two" });
      await expectPng({ brand: "🦊 Fox Docs", title: "Three" });
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("1f98a");
    });
  });

  it("renders a square currentColor logo, hex accent, and long description", async () => {
    await expectPng({
      accent: "#123456",
      description: LONG_DESCRIPTION,
      logo: SQUARE_LOGO,
      title: MEDIUM_TITLE,
    });
  });

  it("renders a custom logo and palette", async () => {
    await expectPng({
      brand: "Acme",
      description: "Branded documentation.",
      logo: SQUARE_LOGO,
      palette: {
        accent: "#ff5410",
        background: "#1d1d1d",
        border: "#323232",
        foreground: "#fff6f2",
        muted: "#a6a19f",
      },
      repo: "acme/docs",
      site: "docs.acme.com",
      title: "Getting started",
    });
  });

  it("scales down a wide wordmark logo and a long title", async () => {
    await expectPng({ logo: WIDE_LOGO, title: LONG_TITLE });
  });

  it("renders a logo-only header, ignoring the brand label", async () => {
    // The header is logo only: a wordmark logo already spells the name, and
    // a brand label beside it duplicated it ("Ultracite  Ultracite").
    await expectPng({ brand: "Ultracite", logo: WIDE_LOGO, title: "Hi" });
  });

  it("falls back to MARK_HEIGHT width for a logo without a viewBox", async () => {
    await expectPng({ logo: NO_VIEWBOX_LOGO, title: "Hi" });
  });

  it("renders a footer with only a repo", async () => {
    await expectPng({ repo: "owner/repo", title: "Hi" });
  });

  it("renders a footer with only a site", async () => {
    await expectPng({ site: "docs.acme.com", title: "Hi" });
  });

  it("renders a footer with both repo and site and an unknown accent", async () => {
    await expectPng({
      accent: "chartreuse",
      description: "A short description.",
      repo: "owner/repo",
      site: "docs.acme.com",
      title: "Hi",
    });
  });

  it("hands non-preset accents to Takumi's CSS color parser", async () => {
    // Anything beyond the named presets passes through verbatim; Takumi
    // parses the full CSS color grammar.
    await expectPng({ accent: "oklch(0.7 0.15 200)", brand: "A", title: "Hi" });
    await expectPng({ accent: "rebeccapurple", brand: "A", title: "Hi" });
  });

  it("fails the render on a malformed accent", async () => {
    // Deliberate fail-fast: a color typo surfaces as a build error naming the
    // value instead of silently shipping a default-colored card.
    await expect(
      renderOgImage({ accent: "#12345", brand: "Acme", title: "Hi" })
    ).rejects.toThrow("#12345");
    // A prototype member name must not resolve up the preset chain into a
    // function; it reaches Takumi as a (rejected) color string instead.
    await expect(
      renderOgImage({ accent: "constructor", brand: "Acme", title: "Hi" })
    ).rejects.toThrow("constructor");
  });

  it("paints an xmlns-less logo instead of silently rendering blank", async () => {
    // Takumi's SVG parser draws nothing without a root xmlns; logoMark injects
    // one. If the logo went blank, both renders would produce identical pixels.
    const red = await renderOgImage({
      logo: filledLogo("#ff0000"),
      title: "Hi",
    });
    const blue = await renderOgImage({
      logo: filledLogo("#0000ff"),
      title: "Hi",
    });
    expect(Buffer.from(red).equals(Buffer.from(blue))).toBe(false);
  });

  it("reads a single-quoted viewBox for the aspect ratio", async () => {
    await expectPng({
      logo: '<svg viewBox=\'0 0 400 40\'><rect fill="currentColor" height="40" width="400" /></svg>',
      title: "Hi",
    });
  });
});
