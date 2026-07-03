import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { tailwindEntryTemplate } from "../src/theme/entry.ts";
import type { FontsConfig } from "../src/theme/fonts.ts";
import {
  buildFontEntries,
  buildFontsCss,
  configuredCssVars,
} from "../src/theme/fonts.ts";
import { hasIcon, resolveIcon } from "../src/theme/icons.ts";
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

  it("rejects a value that could break out of the CSS declaration", () => {
    // A `;}` would end the rule and inject new ones; fall back to the default.
    expect(resolveAccent(themeOf({ accent: "red;}body{display:none}" }))).toBe(
      "oklch(0.62 0.16 250)"
    );
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

describe("buildThemeCss — backgrounds and dark mode", () => {
  it("emits the radial-gradient background decoration", () => {
    const css = buildThemeCss(themeOf({ backgroundDecoration: "gradient" }));
    expect(css).toContain("--blume-background-decoration: radial-gradient");
    expect(css).toContain("--blume-background-decoration-repeat: no-repeat");
  });

  it("emits the grid background decoration", () => {
    const css = buildThemeCss(themeOf({ backgroundDecoration: "grid" }));
    expect(css).toContain("--blume-background-decoration: linear-gradient");
    expect(css).toContain("--blume-background-decoration-size: 2rem 2rem");
  });

  it("emits the windows background decoration", () => {
    const css = buildThemeCss(themeOf({ backgroundDecoration: "windows" }));
    expect(css).toContain("--blume-background-decoration-size: 7rem 4.5rem");
  });

  it("wraps a background image in url() and resolves the action color", () => {
    const css = buildThemeCss(
      themeOf({
        action: "green",
        background: "oklch(0.99 0 0)",
        backgroundImage: "/bg.png",
      })
    );
    expect(css).toContain('--blume-background-image: url("/bg.png");');
    expect(css).toContain("--blume-action: oklch(0.6 0.16 150);");
    expect(css).toContain("--blume-action-foreground: oklch(1 0 0);");
    expect(css).toContain("--blume-background: oklch(0.99 0 0);");
  });

  it("emits a dark-theme block when any dark token is set", () => {
    const css = buildThemeCss(
      themeOf({
        accentDark: "purple",
        backgroundDark: "oklch(0.2 0 0)",
        backgroundImageDark: "/dark.png",
      })
    );
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toContain("--blume-accent: oklch(0.58 0.2 290);");
    expect(css).toContain("--blume-background: oklch(0.2 0 0);");
    expect(css).toContain('--blume-background-image: url("/dark.png");');
  });

  it("omits the dark-theme block when no dark token is set", () => {
    expect(buildThemeCss(themeOf({ accent: "blue" }))).not.toContain(
      'data-theme="dark"'
    );
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

  it("styles the Diff and Component panes", () => {
    expect(entry).toContain("blume-diff");
    expect(entry).toContain("pre.blume-source > code");
  });

  // A stray backtick in a CSS comment silently terminates the template literal,
  // emitting raw `${...}` interpolation markers into the stylesheet (which then
  // fails to parse at build time). Guard against that regression.
  it("emits no uninterpolated template markers", () => {
    expect(entry).not.toContain("${");
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

describe("font builders without a fonts config", () => {
  // An unset `theme.fonts` arrives as undefined; all three builders no-op.
  const absent: { fonts?: FontsConfig } = {};
  it("returns no entries, css, or preload vars when fonts is undefined", () => {
    expect(buildFontEntries(absent.fonts)).toStrictEqual([]);
    expect(buildFontsCss(absent.fonts)).toBe("");
    expect(configuredCssVars(absent.fonts)).toStrictEqual([]);
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

describe("resolveIcon default and explicit libraries", () => {
  it("resolves a bare name against the default (Lucide) library", () => {
    const rocket = resolveIcon("rocket");
    expect(rocket?.viewBox).toBe("0 0 24 24");
    // Lucide bodies are stroke-based and self-styled.
    expect(rocket?.body).toContain('stroke="currentColor"');
  });

  it("resolves an explicit `prefix:name` regardless of default", () => {
    expect(resolveIcon("lucide:star")?.viewBox).toBe("0 0 24 24");
    expect(resolveIcon("fa6-brands:github")?.viewBox).toBe("0 0 496 512");
    expect(resolveIcon("tabler:heart")?.viewBox).toBe("0 0 24 24");
  });

  it("ignores an unknown iconType or library and uses the default", () => {
    expect(resolveIcon("rocket", { iconType: "nope" })?.viewBox).toBe(
      "0 0 24 24"
    );
    expect(resolveIcon("rocket", { library: "nope" })?.viewBox).toBe(
      "0 0 24 24"
    );
  });
});

describe("resolveIcon Font Awesome coverage", () => {
  it("resolves real Font Awesome names under the fontawesome library", () => {
    const opts = { library: "fontawesome" };
    for (const name of ["shield-halved", "layer-group", "gauge-high"]) {
      const icon = resolveIcon(name, opts);
      expect(icon?.viewBox.endsWith(" 512")).toBe(true);
      expect(icon?.body).toContain('fill="currentColor"');
    }
  });

  it("falls back to the brands set for a brand name", () => {
    expect(resolveIcon("github", { library: "fontawesome" })?.viewBox).toBe(
      "0 0 496 512"
    );
    expect(resolveIcon("github", { iconType: "brands" })?.viewBox).toBe(
      "0 0 496 512"
    );
  });

  it("falls Pro-only iconTypes back to solid rather than failing", () => {
    for (const iconType of ["light", "thin", "duotone", "sharp-solid"]) {
      expect(resolveIcon("gauge", { iconType })).not.toBeNull();
    }
  });

  it("checks every bundled library in hasIcon", () => {
    expect(hasIcon("gauge-high")).toBeTruthy();
    expect(hasIcon("rocket")).toBeTruthy();
    expect(hasIcon("fa6-brands:github")).toBeTruthy();
    expect(hasIcon("definitely-not-an-icon-xyz")).toBeFalsy();
  });
});
