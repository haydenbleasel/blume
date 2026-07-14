import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  examplesEntryTemplate,
  tailwindEntryTemplate,
} from "../src/theme/entry.ts";
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
  it("maps a named accent preset to its OKLCH value for both modes", () => {
    expect(resolveAccent(themeOf({ accent: "purple" }))).toStrictEqual({
      dark: "oklch(0.58 0.2 290)",
      light: "oklch(0.58 0.2 290)",
    });
  });

  it("resolves per-mode accents from a { light, dark } object", () => {
    expect(
      resolveAccent(themeOf({ accent: { dark: "teal", light: "purple" } }))
    ).toStrictEqual({
      dark: "oklch(0.6 0.12 195)",
      light: "oklch(0.58 0.2 290)",
    });
  });

  it("passes an unknown accent through as a raw CSS color", () => {
    expect(resolveAccent(themeOf({ accent: "#ff0000" })).light).toBe("#ff0000");
  });

  it("rejects a value that could break out of the CSS declaration", () => {
    // A `;}` would end the rule and inject new ones; fall back to the default.
    expect(
      resolveAccent(themeOf({ accent: "red;}body{display:none}" })).light
    ).toBe("oklch(0.62 0.16 250)");
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
        accent: { dark: "purple", light: "blue" },
        background: { dark: "oklch(0.2 0 0)" },
        backgroundImage: { dark: "/dark.png" },
      })
    );
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toContain("--blume-accent: oklch(0.58 0.2 290);");
    expect(css).toContain("--blume-background: oklch(0.2 0 0);");
    expect(css).toContain('--blume-background-image: url("/dark.png");');
    // A dark-only override must not leak into the light-mode :root block.
    const root = css.slice(0, css.indexOf(':root[data-theme="dark"]'));
    expect(root).not.toContain("--blume-background");
  });

  it("applies a string background to both modes", () => {
    const css = buildThemeCss(themeOf({ background: "oklch(0.5 0 0)" }));
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
    const root = css.slice(0, css.indexOf(':root[data-theme="dark"]'));
    expect(root).toContain("--blume-background: oklch(0.5 0 0);");
    expect(dark).toContain("--blume-background: oklch(0.5 0 0);");
  });

  it("treats prototype member names as raw colors, not presets", () => {
    // ACCENTS["constructor"] resolves the Object constructor up the prototype
    // chain; stringified into CSS it would break the :root rule wide open.
    const css = buildThemeCss(themeOf({ accent: "constructor" }));
    expect(css).not.toContain("function");
    expect(css).toContain("--blume-accent: constructor;");
  });

  it("shares a string accent into dark mode", () => {
    // The base stylesheet's dark block outranks :root config tokens on
    // specificity, so the shared accent must be re-declared for dark.
    const css = buildThemeCss(themeOf({ accent: "teal" }));
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
    expect(dark).toContain("--blume-accent: oklch(0.6 0.12 195);");
    expect(dark).toContain("--blume-accent-foreground: oklch(1 0 0);");
  });

  it("re-declares action for dark mode", () => {
    const css = buildThemeCss(themeOf({ action: "green" }));
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
    expect(dark).toContain("--blume-action: oklch(0.6 0.16 150);");
    expect(dark).toContain("--blume-action-foreground: oklch(1 0 0);");
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

  it("matches native controls to the active color theme", () => {
    expect(entry).toContain(`:root {
  color-scheme: light;
}`);
    expect(entry).toContain(`:root[data-theme="dark"] {
  color-scheme: dark;
}`);
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

  it("keeps code inset in content components but not the API request panel", () => {
    // The code layout rule opts out only the API panel (which owns its layout),
    // not every not-prose subtree — so Tabs, Steps, Callout, etc. keep the inset.
    expect(entry).toContain(
      ".prose :where(pre:not(.twoslash, .twoslash pre, blume-panel-tabs *) > code)"
    );
    expect(entry).not.toContain(".not-prose *) > code)");
  });

  // A stray backtick in a CSS comment silently terminates the template literal,
  // emitting raw `${...}` interpolation markers into the stylesheet (which then
  // fails to parse at build time). Guard against that regression.
  it("emits no uninterpolated template markers", () => {
    expect(entry).not.toContain("${");
  });
});

describe("examplesEntryTemplate", () => {
  const entry = examplesEntryTemplate({
    configTokens: ":root { --blume-accent: red; }",
    sources: ["../../project"],
    userCss: ":root { --primary: hotpink; }",
  });

  it("provides Tailwind, the scanned sources, and the token defaults", () => {
    expect(entry).toContain('@import "tailwindcss";');
    expect(entry).toContain('@source "../../project";');
    expect(entry).toContain("--blume-background: oklch(1 0 0);");
    expect(entry).toContain("--color-background: var(--blume-background);");
    expect(entry).toContain(
      '@custom-variant dark (&:where([data-theme="dark"]'
    );
  });

  it("carries none of the docs theme — no prose or typography plugin", () => {
    // The iframe boundary plus this sheet is the isolation contract: an
    // example must never pick up prose margins or component chrome.
    expect(entry).not.toContain(".prose");
    expect(entry).not.toContain("@plugin");
    expect(entry).not.toContain("blume-tabs");
  });

  it("matches native controls to the active color theme", () => {
    expect(entry).toContain(`:root {
  color-scheme: light;
}`);
    expect(entry).toContain(`:root[data-theme="dark"] {
  color-scheme: dark;
}`);
  });

  it("appends config tokens before the user examples css (user wins)", () => {
    const configAt = entry.indexOf("--blume-accent: red;");
    const userAt = entry.indexOf("--primary: hotpink;");
    expect(configAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(configAt);
  });

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

describe("resolveIcon (Lucide-only)", () => {
  it("resolves a bare name against Lucide", () => {
    const rocket = resolveIcon("rocket");
    expect(rocket?.viewBox).toBe("0 0 24 24");
    // Lucide bodies are stroke-based and self-styled.
    expect(rocket?.body).toContain('stroke="currentColor"');
  });

  it("resolves an explicit `lucide:name` prefix", () => {
    expect(resolveIcon("lucide:star")?.viewBox).toBe("0 0 24 24");
  });

  it("returns null for a non-Lucide prefix (FontAwesome/Tabler are gone)", () => {
    expect(resolveIcon("fa6-brands:github")).toBeNull();
    expect(resolveIcon("tabler:heart")).toBeNull();
  });

  it("returns null for an unknown Lucide name", () => {
    expect(resolveIcon("definitely-not-an-icon-xyz")).toBeNull();
  });

  it("checks Lucide in hasIcon", () => {
    expect(hasIcon("rocket")).toBeTruthy();
    expect(hasIcon("lucide:star")).toBeTruthy();
    expect(hasIcon("definitely-not-an-icon-xyz")).toBeFalsy();
  });

  it("keeps hasIcon and resolveIcon in exact agreement on unknown prefixes", () => {
    // `tabler:check` used to pass hasIcon (bare `check` exists in Lucide) while
    // resolveIcon returned null — callers then rendered an empty icon slot and
    // the nav diagnostics stayed silent.
    expect(resolveIcon("tabler:check")).toBeNull();
    expect(hasIcon("tabler:check")).toBeFalsy();
  });

  it("does not resolve prototype member names up the chain", () => {
    // `constructor:x` in content used to pull the Object constructor out of the
    // lookup maps and crash the build with a TypeError deep in resolution.
    expect(resolveIcon("constructor:github")).toBeNull();
    expect(hasIcon("constructor:nope")).toBeFalsy();
  });
});
