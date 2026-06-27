/**
 * Curated Google Fonts exposed through `theme.fonts`.
 *
 * Each slug maps to the official Google family name (Astro's font provider needs
 * the exact name), a docs-appropriate set of weights, and a fallback category.
 * Fonts are self-hosted and optimized by Astro's built-in Fonts API; this module
 * only resolves config slugs into the data that drives it.
 */

export type FontCategory = "sans" | "serif" | "mono";

/** The three configurable roles in `theme.fonts`. */
export type FontSlot = "display" | "body" | "mono";

interface FontDef {
  category: FontCategory;
  family: string;
  weights: number[];
}

/** Resolved theme fonts (a validated slug per role, all optional). */
export type FontsConfig = Partial<Record<FontSlot, string>> | undefined;

/** A single Astro `fonts:` entry (sans the literal `fontProviders.google()`). */
export interface FontEntry {
  cssVariable: string;
  fallbacks: string[];
  name: string;
  weights: number[];
}

const FALLBACKS: Record<FontCategory, string[]> = {
  mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
  sans: ["ui-sans-serif", "system-ui", "sans-serif"],
  serif: ["ui-serif", "Georgia", "serif"],
};

/** Slug -> Google family + weights + fallback category. Keep keys alphabetical. */
export const GOOGLE_FONTS = {
  "dm-sans": { category: "sans", family: "DM Sans", weights: [400, 500, 700] },
  figtree: {
    category: "sans",
    family: "Figtree",
    weights: [400, 500, 600, 700],
  },
  "fira-code": {
    category: "mono",
    family: "Fira Code",
    weights: [400, 500, 700],
  },
  geist: { category: "sans", family: "Geist", weights: [400, 500, 600, 700] },
  "geist-mono": {
    category: "mono",
    family: "Geist Mono",
    weights: [400, 500, 600],
  },
  "ibm-plex-mono": {
    category: "mono",
    family: "IBM Plex Mono",
    weights: [400, 500, 600],
  },
  "ibm-plex-sans": {
    category: "sans",
    family: "IBM Plex Sans",
    weights: [400, 500, 600, 700],
  },
  "ibm-plex-serif": {
    category: "serif",
    family: "IBM Plex Serif",
    weights: [400, 500, 600],
  },
  inter: { category: "sans", family: "Inter", weights: [400, 500, 600, 700] },
  "inter-tight": {
    category: "sans",
    family: "Inter Tight",
    weights: [400, 500, 600, 700],
  },
  "jetbrains-mono": {
    category: "mono",
    family: "JetBrains Mono",
    weights: [400, 500, 700],
  },
  lora: { category: "serif", family: "Lora", weights: [400, 500, 600, 700] },
  manrope: {
    category: "sans",
    family: "Manrope",
    weights: [400, 500, 600, 700],
  },
  merriweather: {
    category: "serif",
    family: "Merriweather",
    weights: [400, 700],
  },
  "open-sans": {
    category: "sans",
    family: "Open Sans",
    weights: [400, 600, 700],
  },
  "playfair-display": {
    category: "serif",
    family: "Playfair Display",
    weights: [400, 500, 700],
  },
  "plus-jakarta-sans": {
    category: "sans",
    family: "Plus Jakarta Sans",
    weights: [400, 500, 600, 700],
  },
  roboto: { category: "sans", family: "Roboto", weights: [400, 500, 700] },
  "roboto-mono": {
    category: "mono",
    family: "Roboto Mono",
    weights: [400, 500, 700],
  },
  "source-code-pro": {
    category: "mono",
    family: "Source Code Pro",
    weights: [400, 500, 600],
  },
  "source-sans-3": {
    category: "sans",
    family: "Source Sans 3",
    weights: [400, 600, 700],
  },
  "source-serif-4": {
    category: "serif",
    family: "Source Serif 4",
    weights: [400, 600, 700],
  },
  "space-grotesk": {
    category: "sans",
    family: "Space Grotesk",
    weights: [400, 500, 700],
  },
  "space-mono": { category: "mono", family: "Space Mono", weights: [400, 700] },
  "work-sans": {
    category: "sans",
    family: "Work Sans",
    weights: [400, 500, 600],
  },
} satisfies Record<string, FontDef>;

export type FontSlug = keyof typeof GOOGLE_FONTS;

/** All supported slugs, for schema validation and error messages. */
export const FONT_SLUGS = Object.keys(GOOGLE_FONTS);

/** Type guard: is `value` a supported font slug? */
export const isFontSlug = (value: string): value is FontSlug =>
  Object.hasOwn(GOOGLE_FONTS, value);

/** The CSS variable Astro populates for a given font (shared across roles). */
const fontVar = (slug: string): string => `--blume-ff-${slug}`;

const SLOTS: FontSlot[] = ["display", "body", "mono"];

/** The unique Astro `fonts:` entries for the configured roles (deduped). */
export const buildFontEntries = (fonts: FontsConfig): FontEntry[] => {
  if (!fonts) {
    return [];
  }
  const slugs = SLOTS.map((slot) => fonts[slot]).filter(
    (slug): slug is FontSlug => typeof slug === "string" && isFontSlug(slug)
  );
  return [...new Set(slugs)].map((slug) => {
    const def = GOOGLE_FONTS[slug];
    return {
      cssVariable: fontVar(slug),
      fallbacks: FALLBACKS[def.category],
      name: def.family,
      weights: def.weights,
    };
  });
};

/**
 * The config-token CSS that points each role's `--blume-font-<role>-src` at the
 * Astro-populated family variable. Concatenated into the generated entry's
 * config tokens; empty when no fonts are set so defaults stay the system stacks.
 */
export const buildFontsCss = (fonts: FontsConfig): string => {
  if (!fonts) {
    return "";
  }
  const lines = SLOTS.flatMap((slot) => {
    const slug = fonts[slot];
    return slug && isFontSlug(slug)
      ? [`  --blume-font-${slot}-src: var(${fontVar(slug)});`]
      : [];
  });
  return lines.length > 0
    ? `/* Generated by Blume from theme.fonts. */\n:root {\n${lines.join("\n")}\n}\n`
    : "";
};

/** The CSS variables to feed Astro's `<Font>` component in the document head. */
export const configuredCssVars = (fonts: FontsConfig): string[] =>
  buildFontEntries(fonts).map((entry) => entry.cssVariable);
