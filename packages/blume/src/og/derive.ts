/**
 * Bridges `theme.fonts` into the OG card renderer. A site that explicitly
 * picks its typefaces gets matching cards (and non-Latin coverage) without
 * configuring `seo.og.fonts`; untouched defaults derive nothing, so plain
 * sites keep Takumi's built-in font and gain no build-time font fetch.
 */

import { existsSync } from "node:fs";

import { isAbsolute, join } from "pathe";

import type {
  FontsConfig,
  FontValue,
  LocalFontConfig,
} from "../theme/fonts.ts";
import { GOOGLE_FONTS, isFontSlug } from "../theme/fonts.ts";
import type { OgFont, OgFontFamilies, OgLocalFont } from "./card.ts";

/** Fonts plus per-role families for the generated OG endpoint. */
export interface DerivedOgFonts {
  families?: OgFontFamilies;
  fonts: OgFont[];
}

/** The weights the card actually renders at (title 600, everything else 400). */
const CARD_WEIGHTS = [400, 600];

/** Resolve a config path against the project root. */
const absoluteSrc = (root: string, src: string): string =>
  isAbsolute(src) ? src : join(root, src);

/** A concrete numeric face weight (as opposed to a variable-range string). */
const isNumericWeight = (
  weight: number | string | undefined
): weight is number => typeof weight === "number";

/** A variable-range weight spec string, e.g. `"100..900"`. */
const isRangeWeight = (weight: number | string | undefined): weight is string =>
  typeof weight === "string";

/** A theme role configured as a font slug / family-name string. */
const isFontName = (value: FontValue): value is string =>
  typeof value === "string";

/** An OG font entry that reads a local file (as opposed to a Google family). */
const isLocalOgFont = (font: OgFont): font is OgLocalFont =>
  typeof font !== "string" && "src" in font;

/**
 * The weight spec to fetch for a derived Google family: the declared weights
 * the card uses, the declared numeric weights otherwise, a lone variable
 * range as-is, or nothing (family default) as the last resort.
 */
const googleWeights = (
  weights: (number | string)[]
): number[] | string | undefined => {
  const numbers = weights.filter(isNumericWeight);
  const used = numbers.filter((weight) => CARD_WEIGHTS.includes(weight));
  if (used.length > 0) {
    return used;
  }
  if (numbers.length > 0) {
    return numbers;
  }
  const [first] = weights;
  return weights.length === 1 && isRangeWeight(first) ? first : undefined;
};

const googleOgFont = (name: string, weights: (number | string)[]): OgFont => {
  const weight = googleWeights(weights);
  return weight === undefined ? { name } : { name, weight };
};

/** Per-variant local entries for the renderer (paths made absolute). */
const localOgFonts = (font: LocalFontConfig, root: string): OgLocalFont[] =>
  font.variants.map((variant) => {
    const entry: OgLocalFont = {
      name: font.name,
      src: absoluteSrc(root, variant.src),
    };
    const withWeight: OgLocalFont = isNumericWeight(variant.weight)
      ? { ...entry, weight: variant.weight }
      : entry;
    // Takumi's per-face style is normal/italic; oblique falls back to the file.
    return variant.style === "normal" || variant.style === "italic"
      ? { ...withWeight, style: variant.style }
      : withWeight;
  });

/**
 * The card fonts for one theme role, or null when the role can't flow into
 * the renderer (an unknown slug string, or a provider Takumi can't fetch —
 * `googleFonts` only speaks Google's css2 endpoint).
 */
const roleFonts = (value: FontValue, root: string): OgFont[] | null => {
  if (isFontName(value)) {
    if (!isFontSlug(value)) {
      return null;
    }
    const def = GOOGLE_FONTS[value];
    return [googleOgFont(def.family, def.weights)];
  }
  if ("variants" in value) {
    return localOgFonts(value, root);
  }
  if ((value.provider ?? "google") !== "google") {
    return null;
  }
  return [googleOgFont(value.name, value.weights ?? CARD_WEIGHTS)];
};

/** The family name a theme role registers under. */
const roleFamily = (value: FontValue): string | null => {
  if (isFontName(value)) {
    return isFontSlug(value) ? GOOGLE_FONTS[value].family : null;
  }
  return value.name;
};

/**
 * Derive the OG card fonts from the theme's display and body roles (the two
 * the card renders), deduped, plus the per-role family names so the title
 * keeps the display face and the body text the body face.
 */
export const deriveOgFonts = (
  fonts: FontsConfig,
  root: string
): DerivedOgFonts => {
  const derived: OgFont[] = [];
  const seen = new Set<string>();
  const families: OgFontFamilies = {};

  const roles = [
    ["title", fonts?.display],
    ["body", fonts?.body],
  ] as const;
  for (const [role, value] of roles) {
    if (value === undefined) {
      continue;
    }
    const roleEntries = roleFonts(value, root);
    if (!roleEntries) {
      continue;
    }
    families[role] = roleFamily(value) ?? undefined;
    for (const entry of roleEntries) {
      const key = JSON.stringify(entry);
      if (!seen.has(key)) {
        seen.add(key);
        derived.push(entry);
      }
    }
  }

  const result: DerivedOgFonts = { fonts: derived };
  if (families.title || families.body) {
    result.families = families;
  }
  return result;
};

/** Explicit `seo.og.fonts` with local `src` paths resolved to absolute. */
export const resolveOgFontSources = (fonts: OgFont[], root: string): OgFont[] =>
  fonts.map((font) =>
    isLocalOgFont(font) ? { ...font, src: absoluteSrc(root, font.src) } : font
  );

/**
 * The fonts baked into the generated OG endpoint. An explicit `seo.og.fonts`
 * always wins (including `[]` to opt out, keeping the card's role styling
 * untouched); otherwise a site that explicitly set `theme.fonts` gets its
 * display/body fonts derived so cards match the site without extra config.
 */
export const resolveOgFonts = (
  options: {
    /** Explicit `seo.og.fonts`, or undefined when unset. */
    ogFonts: OgFont[] | undefined;
    themeFonts: FontsConfig;
    /** Whether the config file set `theme.fonts` itself (gates derivation). */
    themeFontsConfigured: boolean;
  },
  root: string
): DerivedOgFonts => {
  if (options.ogFonts) {
    return { fonts: resolveOgFontSources(options.ogFonts, root) };
  }
  return options.themeFontsConfigured
    ? deriveOgFonts(options.themeFonts, root)
    : { fonts: [] };
};

/**
 * Every configured local font file (theme roles and `seo.og.fonts`) that is
 * missing on disk, as absolute paths. Generation fails on these up front — the
 * alternative is Astro or the OG renderer crashing later with a bare ENOENT.
 */
export const missingFontFiles = (
  options: { ogFonts: OgFont[]; themeFonts: FontsConfig },
  root: string
): string[] => {
  const sources: string[] = [];
  for (const value of Object.values(options.themeFonts ?? {})) {
    if (!isFontName(value) && "variants" in value) {
      sources.push(
        ...value.variants.map((variant) => absoluteSrc(root, variant.src))
      );
    }
  }
  for (const font of options.ogFonts) {
    if (isLocalOgFont(font)) {
      sources.push(absoluteSrc(root, font.src));
    }
  }
  return [...new Set(sources)].filter((path) => !existsSync(path));
};
