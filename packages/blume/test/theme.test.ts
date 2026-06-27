import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { tailwindEntryTemplate } from "../src/theme/entry.ts";
import {
  buildFontEntries,
  buildFontsCss,
  configuredCssVars,
} from "../src/theme/fonts.ts";
import {
  buildThemeCss,
  resolveAccent,
  resolveRadius,
} from "../src/theme/palette.ts";

const themeOf = (over: Record<string, unknown>) =>
  blumeConfigSchema.parse({ theme: over }).theme;

describe("resolveAccent", () => {
  it("maps a named accent preset to its OKLCH value", () => {
    expect(resolveAccent(themeOf({ accent: "purple" }))).toBe(
      "oklch(0.58 0.2 290)"
    );
  });

  it("passes an unknown accent through as a raw CSS color", () => {
    expect(resolveAccent(themeOf({ accent: "#ff0000" }))).toBe("#ff0000");
  });
});

describe("resolveRadius", () => {
  it("maps each radius preset to a CSS length", () => {
    expect(resolveRadius(themeOf({ radius: "none" }))).toBe("0");
    expect(resolveRadius(themeOf({ radius: "sm" }))).toBe("0.25rem");
    expect(resolveRadius(themeOf({ radius: "md" }))).toBe("0.5rem");
    expect(resolveRadius(themeOf({ radius: "lg" }))).toBe("0.75rem");
  });
});

describe("buildThemeCss", () => {
  it("emits accent and radius custom properties on :root", () => {
    const css = buildThemeCss(themeOf({ accent: "teal", radius: "lg" }));
    expect(css).toContain(":root {");
    expect(css).toContain("--blume-accent: oklch(0.6 0.12 195);");
    expect(css).toContain("--blume-radius: 0.75rem;");
  });
});

describe("tailwindEntryTemplate", () => {
  const entry = tailwindEntryTemplate({
    configTokens: ":root { --blume-accent: red; }",
    sources: ["../pkg", "../project"],
    userTheme: ".prose { color: green; }",
  });

  it("imports Tailwind and the typography plugin", () => {
    expect(entry).toContain('@import "tailwindcss";');
    expect(entry).toContain('@plugin "@tailwindcss/typography";');
  });

  it("emits a @source line for each scanned source", () => {
    expect(entry).toContain('@source "../pkg";');
    expect(entry).toContain('@source "../project";');
  });

  it("declares the data-theme dark variant and base tokens", () => {
    expect(entry).toContain(
      '@custom-variant dark (&:where([data-theme="dark"]'
    );
    expect(entry).toContain("--blume-background: oklch(1 0 0);");
    expect(entry).toContain('[data-theme="dark"]');
  });

  it("appends config tokens before the user theme (user wins)", () => {
    const configAt = entry.indexOf("--blume-accent: red;");
    const userAt = entry.indexOf(".prose { color: green; }");
    expect(configAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(configAt);
  });

  it("routes font tokens through overridable indirection variables", () => {
    expect(entry).toContain("--font-sans: var(--blume-font-body);");
    expect(entry).toContain("--font-mono: var(--blume-font-mono);");
    expect(entry).toContain("--font-display: var(--blume-font-display);");
    // Headings pick up the display font (defaults to body when unset).
    expect(entry).toContain("font-family: var(--font-display);");
  });
});

describe("buildFontEntries", () => {
  it("resolves a slug to its Google family, weights, and fallbacks", () => {
    const [entry] = buildFontEntries({ mono: "ibm-plex-mono" });
    expect(entry).toStrictEqual({
      cssVariable: "--blume-ff-ibm-plex-mono",
      fallbacks: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      name: "IBM Plex Mono",
      weights: [400, 500, 600],
    });
  });

  it("dedupes when multiple roles share a font", () => {
    const entries = buildFontEntries({ body: "inter", display: "inter" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("Inter");
  });

  it("returns no entries when no roles are set", () => {
    expect(buildFontEntries({})).toStrictEqual([]);
  });
});

describe("buildFontsCss", () => {
  it("points each role's src variable at its shared font variable", () => {
    const css = buildFontsCss({
      body: "inter",
      display: "geist",
      mono: "ibm-plex-mono",
    });
    expect(css).toContain("--blume-font-display-src: var(--blume-ff-geist);");
    expect(css).toContain("--blume-font-body-src: var(--blume-ff-inter);");
    expect(css).toContain(
      "--blume-font-mono-src: var(--blume-ff-ibm-plex-mono);"
    );
  });

  it("emits nothing when no roles are set", () => {
    expect(buildFontsCss({})).toBe("");
  });
});

describe("configuredCssVars", () => {
  it("lists the unique Astro font variables to preload", () => {
    expect(
      configuredCssVars({ body: "inter", display: "inter", mono: "geist-mono" })
    ).toStrictEqual(["--blume-ff-inter", "--blume-ff-geist-mono"]);
  });
});

describe("theme.fonts schema", () => {
  it("defaults to Inter Tight / Inter / IBM Plex Mono when omitted", () => {
    expect(themeOf({}).fonts).toStrictEqual({
      body: "inter",
      display: "inter-tight",
      mono: "ibm-plex-mono",
    });
  });

  it("merges an explicit role over the defaults", () => {
    expect(themeOf({ fonts: { body: "geist" } }).fonts).toStrictEqual({
      body: "geist",
      display: "inter-tight",
      mono: "ibm-plex-mono",
    });
  });

  it("rejects an unknown font slug with a helpful message", () => {
    const result = blumeConfigSchema.safeParse({
      theme: { fonts: { body: "comic-sans" } },
    });
    expect(result.success).toBeFalsy();
    expect(result.error?.issues[0]?.message).toContain("Unknown font");
  });
});
