import { Renderer } from "@takumi-rs/core";
import { container, image, text } from "@takumi-rs/helpers";
import type { Node } from "@takumi-rs/helpers";

import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "./dimensions.ts";

// Reuse one renderer (and its loaded default fonts) across all images.
let renderer: Renderer | null = null;
const getRenderer = (): Renderer => {
  renderer ??= new Renderer();
  return renderer;
};

const ACCENT_HEX: Record<string, string> = {
  blue: "#3b82f6",
  green: "#22c55e",
  orange: "#f97316",
  pink: "#ec4899",
  purple: "#8b5cf6",
  red: "#ef4444",
  teal: "#14b8a6",
};

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

// OG rendering uses hex (Takumi's color parser does not accept oklch); named
// presets map to hex, well-formed hex passes through, anything else falls
// back — a malformed hex (`#12345` typo) would throw inside Takumi and fail
// the build at OG prerender with an opaque native error. `hasOwn` keeps a
// preset name like "constructor" from resolving up the prototype chain.
const resolveAccent = (accent: string): string => {
  if (Object.hasOwn(ACCENT_HEX, accent)) {
    return ACCENT_HEX[accent] as string;
  }
  return HEX_COLOR.test(accent) ? accent : "#3b82f6";
};

export interface OgCardOptions {
  /** Large headline — the page title. */
  title: string;
  /** Accent color (named preset or hex) for the fallback brand mark. */
  accent?: string;
  /** Brand/site name shown in the top-left lockup. */
  brand?: string;
  /** Muted subtitle under the headline (usually the site description). */
  description?: string;
  /**
   * Inlined SVG markup of the configured logo (`config.logo.svg`), painted into
   * the brand lockup. Falls back to an accent mark when absent.
   */
  logo?: string;
  /** Footer-left repository slug, e.g. `owner/repo`. */
  repo?: string;
  /** Footer-right site host, e.g. `docs.acme.com`. */
  site?: string;
}

const WIDTH = OG_IMAGE_WIDTH;
const HEIGHT = OG_IMAGE_HEIGHT;

// Light neutral scale mirrored from the docs homepage theme tokens:
// FOREGROUND = --foreground, MUTED = --muted-foreground, FAINT = that lighter,
// BORDER = --border.
const BG = "#fafafa";
const FOREGROUND = "#0a0a0a";
const MUTED = "#737373";
const FAINT = "#a3a3a3";
const BORDER = "#e5e5e5";

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
// Accept either quote style and a non-zero min-x/min-y; only width/height
// matter for the aspect ratio. A miss falls back to a square mark.
const VIEW_BOX =
  /viewBox=(?<q>["'])[\d.-]+[\s,]+[\d.-]+[\s,]+(?<w>[\d.]+)[\s,]+(?<h>[\d.]+)\k<q>/u;

/** The SVG's viewBox aspect ratio (w/h), or null without a usable viewBox. */
const logoAspect = (svg: string): number | null => {
  const box = svg.match(VIEW_BOX);
  const w = Number(box?.groups?.w);
  const h = Number(box?.groups?.h);
  return w && h ? w / h : null;
};

// Render the configured logo as the brand mark. A `currentColor` logo carries
// no intrinsic color, so it is painted in the foreground to read on the light
// card, then handed to Takumi as a data URI sized from the SVG's aspect ratio.
const logoMark = (svg: string): Node => {
  const painted = svg.replaceAll("currentColor", FOREGROUND);
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

/** Render a 1200x630 Open Graph card to a PNG buffer. */
export const renderOgImage = (options: OgCardOptions): Promise<Buffer> => {
  const accent = resolveAccent(options.accent ?? "blue");
  const brand = options.brand?.trim();
  const logo = options.logo?.trim();
  // Slice by code point, not code unit — `charAt(0)` would split a leading
  // surrogate pair (an emoji brand initial) into a lone half that renders blank.
  const initial = brand ? ([...brand][0]?.toUpperCase() ?? "") : "";
  const description = options.description?.trim();
  const repo = options.repo?.trim();
  const site = options.site?.trim();

  // Logo only — no brand-name label beside it. A wordmark logo already spells
  // the name, and rendering the site title next to it duplicated the brand
  // ("Ultracite  Ultracite"). Without a logo, the accent tile with the brand
  // initial stands in.
  const header = container({
    children: [logo ? logoMark(logo) : initialMark(accent, initial)],
    style: { alignItems: "center", display: "flex" },
  });

  const body = container({
    children: [
      text(truncate(options.title, 64), {
        color: FOREGROUND,
        fontSize: titleSize(options.title),
        fontWeight: 600,
        letterSpacing: "-0.03em",
        lineHeight: 1.05,
        maxWidth: 1010,
        textWrap: "balance",
      }),
      description
        ? text(truncate(description, 140), {
            color: MUTED,
            fontSize: 30,
            lineHeight: 1.4,
            marginTop: 28,
            maxWidth: 900,
            textWrap: "balance",
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
              style: { backgroundColor: BORDER, height: 1, width: "100%" },
            }),
            container({
              children: [
                repo
                  ? text(repo, { color: MUTED, fontSize: 22 })
                  : container({}),
                site
                  ? text(site, { color: FAINT, fontSize: 22 })
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
      backgroundColor: BG,
      color: FOREGROUND,
      display: "flex",
      flexDirection: "column",
      height: HEIGHT,
      justifyContent: "space-between",
      padding: 72,
      width: WIDTH,
    },
  });

  return getRenderer().render(node, {
    format: "png",
    height: HEIGHT,
    width: WIDTH,
  });
};
