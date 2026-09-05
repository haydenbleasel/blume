import { readFile } from "node:fs/promises";

import { imageSize } from "image-size";
import { render } from "takumi-js";
import type { RenderOptions } from "takumi-js";
import { container, googleFonts, image, text } from "takumi-js/helpers";
import type { FontSubset, GoogleFontFamily, Node } from "takumi-js/helpers";

import { ACCENTS, isAccentPreset } from "../theme/palette.ts";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "./dimensions.ts";

/** A local font file registered with the OG card renderer, read at build. */
export interface OgLocalFont {
  /** Family name the file's face registers under. */
  name: string;
  /** Absolute path to the font file. */
  src: string;
  /** Face weight; read from the file when omitted. */
  weight?: number;
  /** Face style; read from the file when omitted. */
  style?: "normal" | "italic";
}

/**
 * A font to load into the OG card renderer. A bare string is a Google Fonts
 * family name (weight 400, normal style); the name-only object form pins
 * weight and style. Both are handed to Takumi's `googleFonts` helper, which
 * fetches the families from Google Fonts at build and returns per-glyph
 * coverage subsets. The `src` form reads a local font file instead.
 */
export type OgFont =
  | string
  | {
      /** Google Fonts family name, e.g. `"Noto Sans JP"`. */
      name: string;
      /** `400`, `[400, 700]`, or a variable range like `"100..900"`. */
      weight?: number | number[] | string;
      /** `"normal"`, `"italic"`, or both. */
      style?: "normal" | "italic" | ("normal" | "italic")[];
    }
  | OgLocalFont;

/** Type guard: is this OG font a local file entry? */
const isLocalOgFont = (font: OgFont): font is OgLocalFont =>
  typeof font !== "string" && "src" in font;

/**
 * Which loaded family each card role renders in. Takumi still falls back
 * across every loaded font per glyph, so a family that misses a script
 * degrades to the rest of the chain instead of tofu.
 */
export interface OgFontFamilies {
  /** Family for the description and footer text. */
  body?: string;
  /** Family for the headline. */
  title?: string;
}

// Named presets resolve from the theme's own OKLCH table — Takumi parses the
// full CSS color grammar, so the card renders exactly the accent the site
// shows (a separate hand-synced hex palette used to drift: the card's "blue"
// was Tailwind's, not Blume's). Anything else is handed to Takumi as-is, and
// a genuinely malformed value fails the build with a parse error naming it.
// `isAccentPreset` keeps a preset name like "constructor" from resolving up
// the prototype chain.
const resolveAccent = (accent: string): string =>
  isAccentPreset(accent) ? ACCENTS[accent] : accent;

export interface OgCardPalette {
  accent?: string;
  background?: string;
  border?: string;
  foreground?: string;
  muted?: string;
}

export interface OgCardOptions {
  /** Large headline — the page title. */
  title: string;
  /** Accent color (named preset or any CSS color) for the fallback brand mark. */
  accent?: string;
  /** Brand/site name shown in the top-left lockup. */
  brand?: string;
  /** Muted subtitle under the headline (the page description, else the site's). */
  description?: string;
  /**
   * Inlined SVG markup of the configured logo, painted into the brand
   * lockup. Falls back to an accent mark when absent; `false` renders the
   * card without any brand mark.
   */
  logo?: string | false;
  /** Optional colors for the generated card. */
  palette?: OgCardPalette;
  /** Footer-left repository slug, e.g. `owner/repo`. */
  repo?: string;
  /** Footer-right site host, e.g. `docs.acme.com`. */
  site?: string;
  /**
   * Pre-fetched image entries, or a group controlling how remote images (and
   * emoji glyphs) are fetched. Blume merges in a shared glyph cache; see
   * {@link resolveImages}.
   */
  images?: RenderOptions["images"];
  /**
   * Fonts for non-Latin titles and card branding. Takumi's built-in font
   * covers only Latin, so a CJK (etc.) title renders as tofu without a family
   * that covers its script — see {@link loadFonts}. Local entries are read
   * from disk instead of Google Fonts.
   */
  fonts?: OgFont[];
  /** Per-role families from the loaded fonts (title vs body text). */
  families?: OgFontFamilies;
}

const WIDTH = OG_IMAGE_WIDTH;
const HEIGHT = OG_IMAGE_HEIGHT;

// Emoji in a title render as Twemoji glyphs Takumi fetches from a CDN, once per
// render. A build prerenders one card per page, so an emoji in the site title
// would otherwise refetch the same glyph for every page. This cache is keyed by
// URL and holds the in-flight promise, so concurrent renders share one request
// and a build fetches each glyph once. Unbounded on purpose: it is scoped to the
// glyphs a site's own titles reference, which is a handful.
const imageFetchCache = new Map<string, Promise<ArrayBuffer>>();

/**
 * Merge the shared glyph cache into the caller's `images`. An explicit
 * `fetchCache` wins, so a caller can scope or opt out of the cache.
 */
const resolveImages = (
  images: OgCardOptions["images"]
): OgCardOptions["images"] =>
  Array.isArray(images)
    ? { fetchCache: imageFetchCache, sources: images }
    : { fetchCache: imageFetchCache, ...images };

// Google Fonts subsets keyed by the family set, so a build's identical per-page
// renders build the subset list once. `googleFonts` also caches the css2 request
// process-wide and the shared renderer skips subset files it has already loaded,
// so this only avoids rebuilding the list per card.
const fontSubsetCache = new Map<string, Promise<FontSubset[]>>();

/**
 * Load the configured Google Font families as coverage subsets for `render`'s
 * `fonts` option. `googleFonts` fetches the families from Google Fonts in one
 * css2 request; `render` then registers only the subsets a card's text uses. A
 * fetch failure rejects, failing the build with the cause rather than silently
 * shipping tofu — the same fail-fast the OG accent relies on.
 */
const loadFonts = (
  fonts: Exclude<OgFont, OgLocalFont>[]
): Promise<FontSubset[]> => {
  const key = JSON.stringify(fonts);
  let pending = fontSubsetCache.get(key);
  if (!pending) {
    // SAFETY: OgFont's weight strings are documented as variable ranges like
    // "100..900" (GoogleFontFamily's WeightRange); Takumi validates the value
    // at fetch time and fails the build naming a malformed one.
    pending = googleFonts(fonts as GoogleFontFamily[]);
    fontSubsetCache.set(key, pending);
  }
  return pending;
};

/**
 * A lazy loader for a local font file, matching the shape `render` accepts
 * alongside Google subsets. Keyed by path so the shared renderer reads and
 * registers each file once across a build's per-page renders; a missing file
 * rejects at first use, failing the build with the path in the cause.
 */
/** A lazily-read local font file, in the shape `render` accepts for `fonts`. */
interface LocalFontSource {
  data: () => Promise<Buffer>;
  key: string;
  name: string;
  weight?: number;
  style?: "normal" | "italic";
}

const localFontLoader = (font: OgLocalFont): LocalFontSource => {
  const loader: LocalFontSource = {
    data: () => readFile(font.src),
    key: font.src,
    name: font.name,
  };
  if (font.weight !== undefined) {
    loader.weight = font.weight;
  }
  if (font.style !== undefined) {
    loader.style = font.style;
  }
  return loader;
};

// Light neutral scale mirrored from the docs homepage theme tokens:
// FOREGROUND = --foreground, MUTED = --muted-foreground, FAINT = that lighter,
// BORDER = --border.
const BG = "#fafafa";
const FOREGROUND = "#0a0a0a";
const MUTED = "#737373";
const FAINT = "#a3a3a3";
const BORDER = "#e5e5e5";

const resolvePalette = (
  options: OgCardOptions
): Required<OgCardPalette> & { faint: string } => ({
  accent: resolveAccent(options.palette?.accent ?? options.accent ?? "blue"),
  background: options.palette?.background ?? BG,
  border: options.palette?.border ?? BORDER,
  faint: options.palette?.muted ?? FAINT,
  foreground: options.palette?.foreground ?? FOREGROUND,
  muted: options.palette?.muted ?? MUTED,
});

/**
 * Truncate to `max` code points with an ellipsis. Slices by code points, not
 * UTF-16 units, so cutting mid-emoji doesn't leave a lone surrogate (a broken
 * glyph) before the ellipsis.
 */
export const truncate = (value: string, max: number): string => {
  const chars = [...value];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : value;
};

// Brand mark sizing: target this height, but scale down so an extremely wide
// logo stays within the lockup. The cap leaves room for a wordmark to render
// at full height — it stands alone as the brand (no text label beside it).
const MARK_HEIGHT = 32;
const MARK_MAX_WIDTH = 240;
/**
 * The SVG's aspect ratio (w/h), or null when no usable dimensions exist (the
 * caller falls back to a square mark). image-size (already a dependency)
 * reads explicit width/height and falls back to the viewBox, tolerating the
 * quote/whitespace/attribute spellings the old regex silently missed —
 * `viewBox = "…"`, newline-separated values — which shipped visibly-squashed
 * marks instead of failing loudly.
 */
const logoAspect = (svg: string): number | null => {
  try {
    const { height, width } = imageSize(Buffer.from(svg));
    return width && height ? width / height : null;
  } catch {
    return null;
  }
};

// Render the configured logo as the brand mark. A `currentColor` logo carries
// no intrinsic color, so it is painted in the foreground to read on the light
// card, then handed to Takumi as a data URI sized from the SVG's aspect ratio.
const logoMark = (svg: string, foreground: string): Node => {
  const painted = svg.replaceAll("currentColor", foreground);
  const aspect = logoAspect(painted);
  let height = MARK_HEIGHT;
  let width = aspect ? MARK_HEIGHT * aspect : MARK_HEIGHT;
  if (width > MARK_MAX_WIDTH) {
    height = aspect ? MARK_MAX_WIDTH / aspect : MARK_HEIGHT;
    width = MARK_MAX_WIDTH;
  }
  return image({
    height: Math.round(height),
    src: `data:image/svg+xml;base64,${Buffer.from(painted).toString("base64")}`,
    width: Math.round(width),
  });
};

// Fallback mark when no SVG logo is configured: an accent tile with the brand's
// initial, matching the docs favicon aesthetic.
const initialMark = (accent: string, initial: string): Node =>
  container({
    children: initial
      ? [text(initial, { color: "#ffffff", fontSize: 32, fontWeight: 600 })]
      : [],
    style: {
      alignItems: "center",
      backgroundColor: accent,
      borderRadius: 14,
      display: "flex",
      height: 60,
      justifyContent: "center",
      width: 60,
    },
  });

// The headline shrinks as the title grows so it never spills past a couple of
// lines within the card's content width.
const titleSize = (title: string): number => {
  if (title.length > 60) {
    return 52;
  }
  if (title.length > 40) {
    return 64;
  }
  return 76;
};

/** A spreadable `fontFamily` style, empty when no family is configured. */
const familyStyle = (family?: string): { fontFamily?: string } =>
  family ? { fontFamily: family } : {};

/** Render a 1200x630 Open Graph card to a PNG buffer. */
export const renderOgImage = async (
  options: OgCardOptions
): Promise<Uint8Array> => {
  const { accent, background, border, faint, foreground, muted } =
    resolvePalette(options);
  const brand = options.brand?.trim();
  const logo = options.logo === false ? false : options.logo?.trim();
  // Slice by code point, not code unit — `charAt(0)` would split a leading
  // surrogate pair (an emoji brand initial) into a lone half that renders blank.
  const initial = brand ? ([...brand][0]?.toUpperCase() ?? "") : "";
  const description = options.description?.trim();
  const repo = options.repo?.trim();
  const site = options.site?.trim();
  const titleFamily = familyStyle(options.families?.title);
  const bodyFamily = familyStyle(options.families?.body);

  // Logo only — no brand-name label beside it. A wordmark logo already spells
  // the name, and rendering the site title next to it duplicated the brand
  // ("Ultracite  Ultracite"). Without a logo, the accent tile with the brand
  // initial stands in; `logo: false` opts out of any mark.
  const mark = (): Node[] => {
    if (logo === false) {
      return [];
    }
    return [logo ? logoMark(logo, foreground) : initialMark(accent, initial)];
  };
  const header = container({
    children: mark(),
    style: { alignItems: "center", display: "flex" },
  });

  const body = container({
    children: [
      text(truncate(options.title, 64), {
        color: foreground,
        fontSize: titleSize(options.title),
        fontWeight: 600,
        // Matches the theme's heading tracking (entry.ts h1-h6 rule), tuned
        // for Inter since the display default dropped Inter Tight.
        letterSpacing: "-0.05em",
        lineHeight: 1.05,
        maxWidth: 1010,
        textWrap: "balance",
        ...titleFamily,
      }),
      description
        ? text(truncate(description, 140), {
            color: muted,
            fontSize: 30,
            lineHeight: 1.4,
            marginTop: 28,
            maxWidth: 900,
            textWrap: "balance",
            ...bodyFamily,
          })
        : container({}),
    ],
    style: { display: "flex", flexDirection: "column" },
  });

  const footer =
    repo || site
      ? container({
          children: [
            container({
              style: { backgroundColor: border, height: 1, width: "100%" },
            }),
            container({
              children: [
                repo
                  ? text(repo, { color: muted, fontSize: 22, ...bodyFamily })
                  : container({}),
                site
                  ? text(site, { color: faint, fontSize: 22, ...bodyFamily })
                  : container({}),
              ],
              style: {
                alignItems: "center",
                display: "flex",
                justifyContent: "space-between",
                marginTop: 28,
                width: "100%",
              },
            }),
          ],
          style: { display: "flex", flexDirection: "column", width: "100%" },
        })
      : container({});

  const node = container({
    children: [header, body, footer],
    style: {
      backgroundColor: background,
      color: foreground,
      display: "flex",
      flexDirection: "column",
      height: HEIGHT,
      justifyContent: "space-between",
      padding: 72,
      width: WIDTH,
    },
  });

  const fonts = options.fonts ?? [];
  const googleFamilies = fonts.filter((font) => !isLocalOgFont(font));
  const localFonts = fonts.filter((font) => isLocalOgFont(font));
  // `render` registers only the subsets a card's text uses and skips files it
  // has already loaded, so passing the full font list per page is cheap.
  const fontSubsets = googleFamilies.length
    ? await loadFonts(googleFamilies)
    : [];
  const cardFonts = [...fontSubsets, ...localFonts.map(localFontLoader)];

  return render(node, {
    fonts: cardFonts.length ? cardFonts : undefined,
    format: "png",
    height: HEIGHT,
    images: resolveImages(options.images),
    width: WIDTH,
  });
};
