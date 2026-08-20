/**
 * Fonts exposed through `theme.fonts`.
 *
 * Each role accepts a curated Google Font slug, a remote-provider family (any
 * Google/Fontsource/Bunny/Fontshare family by name), or local font files. All
 * forms resolve to entries for Astro's built-in Fonts API, which self-hosts
 * and optimizes them; this module only resolves config values into the data
 * that drives it.
 */

export type FontCategory = "sans" | "serif" | "mono";

/** The three configurable roles in `theme.fonts`. */
export type FontSlot = "display" | "body" | "mono";

/** Zero-config Astro font providers usable from `theme.fonts`. */
export type RemoteFontProvider =
  | "google"
  | "fontsource"
  | "bunny"
  | "fontshare";

/** A remote-provider family: any family name the provider knows. */
export interface RemoteFontConfig {
  /** Family name as the provider lists it, e.g. `"Noto Sans JP"`. */
  name: string;
  /** Which provider serves the family. Defaults to `"google"`. */
  provider?: RemoteFontProvider;
  /** Weights (or variable ranges like `"100..900"`) to load. Defaults to `[400, 500, 600, 700]`. */
  weights?: (number | string)[];
  /** Fallback stack category. Defaults to `"mono"` for the mono role, `"sans"` otherwise. */
  fallback?: FontCategory;
}

/** One `@font-face` declaration for a local font. */
export interface LocalFontVariant {
  /** Font file path, relative to the project root. */
  src: string;
  /** Face weight; inferred from the file when omitted. */
  weight?: number | string;
  /** Face style; inferred from the file when omitted. */
  style?: "normal" | "italic" | "oblique";
}

/** A self-hosted family loaded from files in the project. */
export interface LocalFontConfig {
  /** Family name used in CSS and the OG card. */
  name: string;
  /** The faces to declare (at least one). */
  variants: LocalFontVariant[];
  /** Fallback stack category. Defaults to `"mono"` for the mono role, `"sans"` otherwise. */
  fallback?: FontCategory;
}

/** A role's font: curated slug, remote family, or local files. */
export type FontValue = string | RemoteFontConfig | LocalFontConfig;

interface FontDef {
  category: FontCategory;
  family: string;
  weights: number[];
}

/** Resolved theme fonts (a validated value per role, all optional). */
export type FontsConfig = Partial<Record<FontSlot, FontValue>> | undefined;

/** A single Astro `fonts:` entry (sans the literal `fontProviders.*()` call). */
export type FontEntry =
  | {
      kind: "remote";
      provider: RemoteFontProvider;
      cssVariable: string;
      fallbacks: string[];
      name: string;
      weights: (number | string)[];
    }
  | {
      kind: "local";
      cssVariable: string;
      fallbacks: string[];
      name: string;
      variants: LocalFontVariant[];
    };

const FALLBACKS = {
  mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
  sans: ["ui-sans-serif", "system-ui", "sans-serif"],
  serif: ["ui-serif", "Georgia", "serif"],
} satisfies Record<FontCategory, string[]>;

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

/** Weights loaded for a remote family when the config does not pin them. */
const DEFAULT_REMOTE_WEIGHTS: (number | string)[] = [400, 500, 600, 700];

/** Kebab-case a family name into a slug (`"Noto Sans JP"` -> `"noto-sans-jp"`). */
export const slugifyFontName = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    // The collapse above leaves only single dashes, so no quantifiers needed
    // (an unanchored `-+$` backtracks quadratically on long dash runs).
    .replaceAll(/^-|-$/gu, "");

/** The CSS variable Astro populates for a given font (shared across roles). */
const fontVar = (slug: string): string => `--blume-ff-${slug}`;

const SLOTS: FontSlot[] = ["display", "body", "mono"];

/** The fallback category a role uses when a custom font does not pick one. */
const slotCategory = (slot: FontSlot): FontCategory =>
  slot === "mono" ? "mono" : "sans";

/** Whether a slot value is the slug-string form (vs a custom font object). */
const isSlugValue = (value: FontValue): value is string =>
  typeof value === "string";

/** A slot value normalized into an entry, or null for an unknown slug string. */
const resolveFontValue = (
  slot: FontSlot,
  value: FontValue
): FontEntry | null => {
  if (isSlugValue(value)) {
    if (!isFontSlug(value)) {
      return null;
    }
    const def = GOOGLE_FONTS[value];
    return {
      cssVariable: fontVar(value),
      fallbacks: FALLBACKS[def.category],
      kind: "remote",
      name: def.family,
      provider: "google",
      weights: def.weights,
    };
  }
  const slug = slugifyFontName(value.name);
  const fallbacks = FALLBACKS[value.fallback ?? slotCategory(slot)];
  if ("variants" in value) {
    return {
      cssVariable: fontVar(slug),
      fallbacks,
      kind: "local",
      name: value.name,
      variants: value.variants,
    };
  }
  return {
    cssVariable: fontVar(slug),
    fallbacks,
    kind: "remote",
    name: value.name,
    provider: value.provider ?? "google",
    weights: value.weights ?? DEFAULT_REMOTE_WEIGHTS,
  };
};

/**
 * Merge two entries that resolved to the same CSS variable. The same remote
 * family configured twice unions its weights (so a custom `{ name: "Inter" }`
 * coexists with the curated `inter` default in another role); identical local
 * definitions collapse. Anything else is a config conflict worth failing on.
 */
const mergeFontEntries = (current: FontEntry, next: FontEntry): FontEntry => {
  if (
    current.kind === "remote" &&
    next.kind === "remote" &&
    current.provider === next.provider &&
    current.name === next.name
  ) {
    return {
      ...current,
      weights: [...new Set([...current.weights, ...next.weights])],
    };
  }
  if (
    current.kind === "local" &&
    next.kind === "local" &&
    current.name === next.name &&
    JSON.stringify(current.variants) === JSON.stringify(next.variants)
  ) {
    return current;
  }
  throw new Error(
    `theme.fonts: "${next.name}" conflicts with "${current.name}" — both resolve to the CSS variable "${current.cssVariable}" with different definitions. Rename one family or align their definitions.`
  );
};

/** The unique Astro `fonts:` entries for the configured roles (deduped). */
export const buildFontEntries = (fonts: FontsConfig): FontEntry[] => {
  if (!fonts) {
    return [];
  }
  const entries = new Map<string, FontEntry>();
  for (const slot of SLOTS) {
    const value = fonts[slot];
    if (value === undefined) {
      continue;
    }
    const entry = resolveFontValue(slot, value);
    if (!entry) {
      continue;
    }
    const current = entries.get(entry.cssVariable);
    entries.set(
      entry.cssVariable,
      current ? mergeFontEntries(current, entry) : entry
    );
  }
  return [...entries.values()];
};

/** The slug backing a slot's CSS variable, or null for an unknown slug string. */
const slotSlug = (value: FontValue): string | null => {
  if (isSlugValue(value)) {
    return isFontSlug(value) ? value : null;
  }
  return slugifyFontName(value.name);
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
    const value = fonts[slot];
    if (value === undefined) {
      return [];
    }
    const slug = slotSlug(value);
    return slug ? [`  --blume-font-${slot}-src: var(${fontVar(slug)});`] : [];
  });
  return lines.length > 0
    ? `/* Generated by Blume from theme.fonts. */\n:root {\n${lines.join("\n")}\n}\n`
    : "";
};

/**
 * Weights worth preloading per role — the faces above-the-fold text actually
 * renders in: body copy and UI chrome at 400/500, headings at 500/600, code at
 * 400. Every other face still loads on demand through its `@font-face` rule
 * (and `font-display: swap` never blocks text on it), so preloading the long
 * tail only competes with the critical CSS for bandwidth and pushes LCP out.
 */
const PRELOAD_WEIGHTS = {
  body: [400, 500],
  display: [500, 600],
  mono: [400],
} satisfies Record<FontSlot, number[]>;

/** One `<Font>` render in the head: its CSS variable + weights to preload. */
export interface FontHead {
  cssVariable: string;
  preloadWeights: number[];
}

/** The weights an entry's faces declare (`undefined` = inferred from files). */
const entryWeights = (entry: FontEntry): (number | string | undefined)[] =>
  entry.kind === "remote"
    ? entry.weights
    : entry.variants.map((variant) => variant.weight);

/**
 * The role's preferred preload weights, narrowed to faces the family loads.
 * Variable ranges (`"100..900"`) and weight-inferred local files can serve any
 * weight, so they keep the preferred list; a family whose numeric weights miss
 * the preferred ones entirely preloads all of its faces instead — those are
 * what its text renders in.
 */
const preloadWeightsFor = (slot: FontSlot, entry: FontEntry): number[] => {
  const preferred = PRELOAD_WEIGHTS[slot];
  const weights = entryWeights(entry);
  const numeric = weights.filter(
    (weight): weight is number => typeof weight === "number"
  );
  const hits = preferred.filter((weight) => numeric.includes(weight));
  if (hits.length > 0) {
    return hits;
  }
  return numeric.length === weights.length ? numeric : preferred;
};

/**
 * The fonts to feed Astro's `<Font>` component in the document head, deduped
 * by CSS variable with preload weights unioned across the roles that share a
 * family (so `display` and `body` both set to Inter preload 400/500/600 once).
 */
export const configuredFonts = (fonts: FontsConfig): FontHead[] => {
  if (!fonts) {
    return [];
  }
  const heads = new Map<string, Set<number>>();
  for (const slot of SLOTS) {
    const value = fonts[slot];
    if (value === undefined) {
      continue;
    }
    const entry = resolveFontValue(slot, value);
    if (!entry) {
      continue;
    }
    const weights = heads.get(entry.cssVariable) ?? new Set();
    for (const weight of preloadWeightsFor(slot, entry)) {
      weights.add(weight);
    }
    heads.set(entry.cssVariable, weights);
  }
  return [...heads].map(([cssVariable, weights]) => ({
    cssVariable,
    preloadWeights: [...weights].toSorted((a, b) => a - b),
  }));
};
