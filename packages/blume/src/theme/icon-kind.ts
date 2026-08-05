/**
 * Classify author-supplied icon strings — built-in Lucide names vs image
 * paths/URLs vs inline SVG. Shared by nav diagnostics, `<Icon>`, and the
 * Cmd+K popular-icon resolver so the three shapes stay in sync.
 */

const IMAGE_ICON =
  /^(?:https?:\/\/|data:image\/|\/|\.{1,2}\/)|\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;

const INLINE_SVG = /^\s*<svg[\s\S]*<\/svg>\s*$/u;

/** Image path, remote URL, or data URI — not a Lucide name or inline SVG. */
export const isImageIcon = (value: string): boolean => IMAGE_ICON.test(value);

/** Full `<svg>…</svg>` markup (whitespace-tolerant). */
export const isInlineSvg = (value: string): boolean => INLINE_SVG.test(value);

/** Image or inline SVG — anything that is not a built-in icon name. */
export const isAssetIcon = (value: string): boolean =>
  isInlineSvg(value) || isImageIcon(value);
