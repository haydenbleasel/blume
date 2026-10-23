import { readFile } from "node:fs/promises";

import { render } from "takumi-js";
import type { RenderOptions } from "takumi-js";
import {
  collectCodepoints,
  container,
  googleFonts,
  image,
  subsetFonts,
  text,
} from "takumi-js/helpers";
import type { FontSubset, GoogleFontFamily, Node } from "takumi-js/helpers";

import { svgDimensions } from "../core/svg-dimensions.ts";
import { ACCENTS, isAccentPreset } from "../theme/palette.ts";
import { isLocalOgFont, throughCardCache } from "./cache.ts";
import type { OgCache } from "./cache.ts";
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

/** An OG font fetched from Google Fonts (a bare family name or the object form). */
export type OgGoogleFont = Exclude<OgFont, OgLocalFont>;

/**
 * Which loaded family each card role renders in, by plain family name (the
 * card quotes it for the renderer). Takumi still falls back across every
 * loaded font per glyph, so a family that misses a script degrades to the
 * rest of the chain instead of tofu.
 */
export interface OgFontFamilies {
  /** Family for the description and footer text. */
  body?: string;
  /** Family for the headline. */
  title?: string;
}

// Named presets resolve from the theme's own OKLCH table, in their light
// shade since the card is light — Takumi parses the full CSS color grammar,
// so the card renders exactly the accent the site shows (a separate
// hand-synced hex palette used to drift: the card's "blue" was Tailwind's,
// not Blume's). Anything else is handed to Takumi as-is, and a genuinely
// malformed value fails the build with a parse error naming it.
// `isAccentPreset` keeps a preset name like "constructor" from resolving up
// the prototype chain.
const resolveAccent = (accent: string): string =>
  isAccentPreset(accent) ? ACCENTS[accent].light : accent;

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
  /**
   * Script fallbacks, tried after `fonts` for glyphs nothing else draws. A
   * card loads them only when its text needs one, so a Latin-only card never
   * fetches them — see {@link fallbackSubsets}.
   */
  fallbacks?: OgGoogleFont[];
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

/** Fetch `fonts`' subsets, dropping the cache entry at `key` if that fails. */
const fetchFonts = async (
  key: string,
  fonts: OgGoogleFont[]
): Promise<FontSubset[]> => {
  try {
    // SAFETY: OgFont's weight strings are documented as variable ranges like
    // "100..900" (GoogleFontFamily's WeightRange); Takumi validates the value
    // at fetch time and fails the build naming a malformed one.
    return await googleFonts(fonts as GoogleFontFamily[]);
  } catch (error) {
    fontSubsetCache.delete(key);
    throw error;
  }
};

/**
 * Load the configured Google Font families as coverage subsets for `render`'s
 * `fonts` option. `googleFonts` fetches the families from Google Fonts in one
 * css2 request; `render` then registers only the subsets a card's text uses. A
 * fetch failure rejects, failing the build with the cause rather than silently
 * shipping tofu — the same fail-fast the OG accent relies on. The failure is
 * dropped from the cache, so a long-lived `blume dev` retries on the next card
 * instead of failing every card until a restart.
 */
const loadFonts = (fonts: OgGoogleFont[]): Promise<FontSubset[]> => {
  const key = JSON.stringify(fonts);
  let pending = fontSubsetCache.get(key);
  if (!pending) {
    pending = fetchFonts(key, fonts);
    fontSubsetCache.set(key, pending);
  }
  return pending;
};

/**
 * The vertical tab, next line, and line and paragraph separators, which Takumi
 * draws as missing glyphs. It lays a line feed out as a space, so these
 * become one too.
 */
const STRAY_BREAKS = /[\v\u0085\u2028\u2029]/gu;

/** `value` with its {@link STRAY_BREAKS} turned into spaces. */
const withPlainBreaks = (value: string): string =>
  value.replaceAll(STRAY_BREAKS, " ");

/**
 * The code points Takumi's built-in Geist draws: whitespace (not the
 * {@link STRAY_BREAKS}, which a card turns into spaces first), printable
 * ASCII, Latin-1 except `µ`, a few Latin extras French needs, and the
 * typographic punctuation English copy leans on. Probed against the renderer,
 * and `og-card.test.ts` renders every one, so a Takumi upgrade that drops a
 * glyph fails there instead of shipping tofu.
 */
export const BUILT_IN_GLYPHS: [number, number][] = [
  [0x09, 0x0a],
  [0x0c, 0x0d],
  [0x20, 0x7e],
  [0xa0, 0xb4],
  [0xb6, 0xff],
  [0x1_31, 0x1_31],
  [0x1_52, 0x1_53],
  [0x1_78, 0x1_78],
  [0x20_00, 0x20_0f],
  [0x20_13, 0x20_14],
  [0x20_18, 0x20_1a],
  [0x20_1c, 0x20_1e],
  [0x20_20, 0x20_22],
  [0x20_26, 0x20_26],
  [0x20_2a, 0x20_30],
  [0x20_32, 0x20_33],
  [0x20_39, 0x20_3a],
  [0x20_44, 0x20_44],
  [0x20_5f, 0x20_6f],
  [0x20_ac, 0x20_ac],
  [0x21_22, 0x21_22],
  [0x21_91, 0x21_91],
  [0x21_93, 0x21_93],
  [0x22_12, 0x22_12],
];

/** Emoji render as Twemoji images, never from a font. */
const EMOJI = /\p{Emoji_Presentation}|\p{Emoji_Component}/u;

/** Whether a card draws `codePoint` without any loaded font. */
const drawnWithoutFonts = (codePoint: number): boolean =>
  BUILT_IN_GLYPHS.some(([from, to]) => codePoint >= from && codePoint <= to) ||
  EMOJI.test(String.fromCodePoint(codePoint));

/**
 * The subsets of `subsets` that claim any of `codePoints` (a subset without a
 * `unicode-range` claims all). Takumi's own `subsetFonts` decides, so Blume
 * never reads a subset's range field itself.
 */
const claiming = (subsets: FontSubset[], codePoints: number[]): FontSubset[] =>
  subsetFonts({ fonts: subsets, source: String.fromCodePoint(...codePoints) });

/** `subsets` grouped by family, in the order each family first appears. */
const byFamily = (subsets: FontSubset[]): FontSubset[][] => {
  const families = new Map<string, FontSubset[]>();
  for (const subset of subsets) {
    const family = families.get(subset.name);
    if (family) {
      family.push(subset);
    } else {
      families.set(subset.name, [subset]);
    }
  }
  return [...families.values()];
};

/**
 * The scripts only the CJK families draw. Google slices those fonts by the
 * glyphs each one really has, so the first family claiming such a character
 * draws it. Other claims follow Google's shared subset definitions whatever
 * the font holds — every family's `latin` claims `※`, Arabic's `symbols`
 * claims `→` — so a claim there proves nothing.
 */
const CJK_SCRIPTS =
  /[\p{Script=Bopomofo}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Whether a claim on `codePoint` means the claiming family draws it. */
const claimIsExact = (codePoint: number): boolean =>
  CJK_SCRIPTS.test(String.fromCodePoint(codePoint));

/**
 * The fallback subsets a card's text needs. Nothing loads, and nothing is
 * fetched, when the built-in font draws every glyph, so a Latin-only card
 * builds offline. Otherwise only subsets claiming a glyph beyond the built-in
 * font load (not every family's `latin`), and a CJK character stops at the
 * first family that claims it: all four CJK families claim most Han, so left
 * to `render` each would download its matching slices although only the
 * first ever paints them.
 */
const fallbackSubsets = async (
  fallbacks: OgGoogleFont[] | undefined,
  node: Node
): Promise<FontSubset[]> => {
  let missing = [...collectCodepoints(node)].filter(
    (codePoint) => !drawnWithoutFonts(codePoint)
  );
  if (!fallbacks?.length || missing.length === 0) {
    return [];
  }
  const needed: FontSubset[] = [];
  for (const family of byFamily(await loadFonts(fallbacks))) {
    if (missing.length === 0) {
      break;
    }
    const matching = claiming(family, missing);
    needed.push(...matching);
    missing = missing.filter(
      (codePoint) =>
        !(claimIsExact(codePoint) && claiming(matching, [codePoint]).length)
    );
  }
  return needed;
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
 * caller falls back to a square mark). The shared root-tag parser reads
 * explicit width/height and falls back to the viewBox, so the card and the
 * header measure one logo the same way.
 */
const logoAspect = (svg: string): number | null => {
  const size = svgDimensions(svg);
  return size ? size.width / size.height : null;
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
// initial, matching the docs favicon aesthetic. The initial takes the headline's
// family, so it matches the title rather than whichever loaded font comes first.
const initialMark = (
  accent: string,
  initial: string,
  family: { fontFamily?: string }
): Node =>
  container({
    children: initial
      ? [
          text(initial, {
            color: "#ffffff",
            fontSize: 32,
            fontWeight: 600,
            ...family,
          }),
        ]
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

/**
 * `family` as a quoted CSS string. Takumi parses `fontFamily` with the CSS
 * grammar, where an unquoted family must be a run of identifiers, so a name
 * with a token that starts with a digit ("Source Sans 3", "3270") fails the
 * render. A quoted string accepts any name, escaped per CSS.
 */
const cssFamilyName = (family: string): string =>
  `"${family.replaceAll(/["\\]/gu, "\\$&")}"`;

/** A spreadable `fontFamily` style, empty when no family is configured. */
const familyStyle = (family?: string): { fontFamily?: string } =>
  family ? { fontFamily: cssFamilyName(family) } : {};

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
  const title = withPlainBreaks(options.title);
  const description =
    options.description && withPlainBreaks(options.description).trim();
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
    return [
      logo
        ? logoMark(logo, foreground)
        : initialMark(accent, initial, titleFamily),
    ];
  };
  const header = container({
    children: mark(),
    style: { alignItems: "center", display: "flex" },
  });

  const body = container({
    children: [
      text(truncate(title, 64), {
        color: foreground,
        fontSize: titleSize(title),
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
  const cardFonts = [
    ...fontSubsets,
    ...localFonts.map(localFontLoader),
    ...(await fallbackSubsets(options.fallbacks, node)),
  ];

  return render(node, {
    fonts: cardFonts.length ? cardFonts : undefined,
    format: "png",
    height: HEIGHT,
    images: resolveImages(options.images),
    width: WIDTH,
  });
};

/**
 * {@link renderOgImage} through the on-disk card cache: a card whose inputs
 * match one rendered by a previous build (or an earlier page of this one) is
 * read back instead of rendered. `cache` undefined renders every card.
 */
export const cachedOgImage = (
  cache: OgCache | undefined,
  options: OgCardOptions
): Promise<Uint8Array> => throughCardCache(cache, options, renderOgImage);
