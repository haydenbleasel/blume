import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import {
  examplesEntryTemplate,
  tailwindEntryTemplate,
} from "../src/theme/entry.ts";
import type { FontsConfig } from "../src/theme/fonts.ts";
import {
  buildFontEntries,
  buildFontsCss,
  configuredFonts,
  slugifyFontName,
} from "../src/theme/fonts.ts";
import { hasIcon, resolveIcon } from "../src/theme/icons.ts";
import {
  buildThemeCss,
  resolveAccent,
  resolveRadius,
} from "../src/theme/palette.ts";

const themeOf = (over: BlumeConfigInput["theme"]) =>
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

  it("declares no cross-document view transitions (the client router owns navigation)", () => {
    // Astro's <ClientRouter /> in the layouts drives page transitions — and
    // ships its own reduced-motion guard. A `@view-transition` opt-in here
    // would double-animate the full-load navigations the router hands back
    // to the browser.
    expect(entry).not.toContain("@view-transition");
  });

  it("bakes display-grade tracking into headings, not the font", () => {
    // Any display font gets tightened heading tracking from the theme — the
    // Inter default (and most text families) reads loose at heading sizes.
    // -0.05em was matched visually against the old Inter Tight default.
    expect(entry).toContain(`font-family: var(--font-display);
    letter-spacing: -0.05em;`);
    // Prose headings must not reset it — a `letter-spacing: 0` in the
    // higher-specificity `.prose :where(h1…)` rule silently undoes the
    // tracking on every docs page.
    expect(entry).not.toContain("letter-spacing: 0;");
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
      kind: "remote",
      name: "IBM Plex Mono",
      provider: "google",
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

  it("skips an unknown slug string instead of throwing", () => {
    expect(buildFontEntries({ body: "not-a-real-slug" })).toStrictEqual([]);
  });

  it("resolves a remote family with default provider and weights", () => {
    const [entry] = buildFontEntries({
      body: { name: "Noto Sans JP" },
    });
    expect(entry).toStrictEqual({
      cssVariable: "--blume-ff-noto-sans-jp",
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
      kind: "remote",
      name: "Noto Sans JP",
      provider: "google",
      weights: [400, 500, 600, 700],
    });
  });

  it("keeps a remote family's provider, weights, and fallback override", () => {
    const [entry] = buildFontEntries({
      display: {
        fallback: "serif",
        name: "Supreme",
        provider: "fontsource",
        weights: [400, "100..900"],
      },
    });
    expect(entry).toStrictEqual({
      cssVariable: "--blume-ff-supreme",
      fallbacks: ["ui-serif", "Georgia", "serif"],
      kind: "remote",
      name: "Supreme",
      provider: "fontsource",
      weights: [400, "100..900"],
    });
  });

  it("defaults a custom font in the mono role to the mono fallback stack", () => {
    const [entry] = buildFontEntries({ mono: { name: "Berkeley Mono" } });
    expect(entry?.fallbacks).toStrictEqual([
      "ui-monospace",
      "SF Mono",
      "Menlo",
      "monospace",
    ]);
  });

  it("resolves a local family to its variants", () => {
    const [entry] = buildFontEntries({
      display: {
        name: "Custom Sans",
        variants: [
          { src: "./fonts/custom.woff2", weight: 400 },
          { src: "./fonts/custom-italic.woff2", style: "italic", weight: 400 },
        ],
      },
    });
    expect(entry).toStrictEqual({
      cssVariable: "--blume-ff-custom-sans",
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
      kind: "local",
      name: "Custom Sans",
      variants: [
        { src: "./fonts/custom.woff2", weight: 400 },
        { src: "./fonts/custom-italic.woff2", style: "italic", weight: 400 },
      ],
    });
  });

  it("unions weights when a custom entry names a curated family", () => {
    const entries = buildFontEntries({
      body: "inter",
      display: { name: "Inter", weights: [400, 900] },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "Inter",
      weights: [400, 900, 500, 600, 700],
    });
  });

  it("collapses identical local definitions across roles", () => {
    const local = {
      name: "Custom Sans",
      variants: [{ src: "./fonts/custom.woff2" }],
    };
    const entries = buildFontEntries({ body: local, display: local });
    expect(entries).toHaveLength(1);
  });

  it("throws when two roles conflict on the same CSS variable", () => {
    expect(() =>
      buildFontEntries({
        body: { name: "Custom Sans", variants: [{ src: "./a.woff2" }] },
        display: { name: "Custom Sans" },
      })
    ).toThrow(/conflicts/u);
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

  it("slugifies custom family names into their font variables", () => {
    const css = buildFontsCss({
      body: { name: "Noto Sans JP" },
      mono: { name: "Berkeley Mono", variants: [{ src: "./fonts/bm.woff2" }] },
    });
    expect(css).toContain(
      "--blume-font-body-src: var(--blume-ff-noto-sans-jp);"
    );
    expect(css).toContain(
      "--blume-font-mono-src: var(--blume-ff-berkeley-mono);"
    );
  });

  it("trims leading and trailing separator runs when slugifying", () => {
    expect(slugifyFontName(" -- Noto Sans JP -- ")).toBe("noto-sans-jp");
    expect(slugifyFontName("---")).toBe("");
  });

  it("skips an unknown slug string", () => {
    expect(buildFontsCss({ body: "not-a-real-slug" })).toBe("");
  });
});

describe("configuredFonts", () => {
  it("dedupes shared families and unions their roles' preload weights", () => {
    // Inter serves body (400/500) and display (500/600) → one entry, 400-600.
    expect(
      configuredFonts({ body: "inter", display: "inter", mono: "geist-mono" })
    ).toStrictEqual([
      { cssVariable: "--blume-ff-inter", preloadWeights: [400, 500, 600] },
      { cssVariable: "--blume-ff-geist-mono", preloadWeights: [400] },
    ]);
  });

  it("preloads all faces of a family missing the role's preferred weights", () => {
    // Merriweather only ships 400/700 — neither display preference (500/600)
    // exists, so both of its faces preload (they're what headings render in).
    expect(configuredFonts({ display: "merriweather" })).toStrictEqual([
      { cssVariable: "--blume-ff-merriweather", preloadWeights: [400, 700] },
    ]);
  });

  it("keeps the preferred weights for variable ranges", () => {
    expect(
      configuredFonts({ body: { name: "Custom Var", weights: ["100..900"] } })
    ).toStrictEqual([
      { cssVariable: "--blume-ff-custom-var", preloadWeights: [400, 500] },
    ]);
  });

  it("narrows local fonts to declared weights and trusts inferred ones", () => {
    expect(
      configuredFonts({
        body: {
          name: "Local Declared",
          variants: [
            { src: "fonts/regular.woff2", weight: 400 },
            { src: "fonts/bold.woff2", weight: 700 },
          ],
        },
        mono: {
          name: "Local Inferred",
          variants: [{ src: "fonts/mono.woff2" }],
        },
      })
    ).toStrictEqual([
      { cssVariable: "--blume-ff-local-declared", preloadWeights: [400] },
      { cssVariable: "--blume-ff-local-inferred", preloadWeights: [400] },
    ]);
  });

  it("skips unset roles and unknown slug strings", () => {
    expect(configuredFonts({ body: "not-a-real-slug" })).toStrictEqual([]);
  });
});

/** A theme whose `fonts` was never set — what the builders see in that case. */
interface FontlessTheme {
  fonts?: FontsConfig;
}

describe("font builders without a fonts config", () => {
  // An unset `theme.fonts` arrives as undefined; all three builders no-op.
  const absent: FontlessTheme = {};
  it("returns no entries, css, or preload vars when fonts is undefined", () => {
    expect(buildFontEntries(absent.fonts)).toStrictEqual([]);
    expect(buildFontsCss(absent.fonts)).toBe("");
    expect(configuredFonts(absent.fonts)).toStrictEqual([]);
  });
});

describe("theme.fonts schema", () => {
  it("defaults to Inter / Inter / IBM Plex Mono when omitted", () => {
    expect(themeOf({}).fonts).toStrictEqual({
      body: "inter",
      display: "inter",
      mono: "ibm-plex-mono",
    });
  });

  it("merges an explicit role over the defaults", () => {
    expect(themeOf({ fonts: { body: "geist" } }).fonts).toStrictEqual({
      body: "geist",
      display: "inter",
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

  it("accepts a remote family object and defaults its provider", () => {
    const theme = themeOf({
      fonts: { body: { name: "Noto Sans JP", weights: [400, 700] } },
    });
    expect(theme.fonts.body).toStrictEqual({
      name: "Noto Sans JP",
      provider: "google",
      weights: [400, 700],
    });
  });

  it("accepts a local family with variants", () => {
    const theme = themeOf({
      fonts: {
        mono: {
          fallback: "mono",
          name: "Berkeley Mono",
          variants: [{ src: "./fonts/bm.woff2", style: "normal", weight: 400 }],
        },
      },
    });
    expect(theme.fonts.mono).toStrictEqual({
      fallback: "mono",
      name: "Berkeley Mono",
      variants: [{ src: "./fonts/bm.woff2", style: "normal", weight: 400 }],
    });
  });

  it("rejects an unknown remote provider", () => {
    const result = blumeConfigSchema.safeParse({
      theme: { fonts: { body: { name: "Inter", provider: "adobe" } } },
    });
    expect(result.success).toBeFalsy();
  });

  it("rejects empty weights and empty variants", () => {
    expect(
      blumeConfigSchema.safeParse({
        theme: { fonts: { body: { name: "Inter", weights: [] } } },
      }).success
    ).toBeFalsy();
    expect(
      blumeConfigSchema.safeParse({
        theme: { fonts: { body: { name: "Custom", variants: [] } } },
      }).success
    ).toBeFalsy();
  });

  it("rejects a malformed weight range string", () => {
    const result = blumeConfigSchema.safeParse({
      theme: { fonts: { body: { name: "Inter", weights: ["bold"] } } },
    });
    expect(result.success).toBeFalsy();
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
