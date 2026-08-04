import { resolveIcon } from "../theme/icons.ts";

const IMAGE_ICON =
  /^(?:https?:\/\/|data:image\/|\/|\.{1,2}\/)|\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;

/** Escape a value for use inside a double-quoted HTML attribute. */
const escapeAttr = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/**
 * Resolve a `search.popular` icon to ready-to-inject markup for the Cmd+K
 * island. Built-in names become Lucide SVG; image paths/URLs become `<img>`;
 * author-supplied inline `<svg>` passes through. Same shapes `Icon.astro`
 * accepts for nav — resolved on the server so the island never loads the icon
 * set.
 */
export const resolvePopularIconMarkup = (
  icon: string | undefined,
  withBase: (src: string) => string
): string | undefined => {
  if (!icon) {
    return undefined;
  }
  const trimmed = icon.trim();
  if (/^<svg[\s\S]*<\/svg>$/u.test(trimmed)) {
    return trimmed;
  }
  if (IMAGE_ICON.test(trimmed)) {
    return `<img src="${escapeAttr(withBase(trimmed))}" width="16" height="16" alt="" aria-hidden="true" class="size-4" />`;
  }
  const resolved = resolveIcon(trimmed);
  return resolved
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="${resolved.viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${resolved.body}</svg>`
    : undefined;
};
