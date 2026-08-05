import { prefixBase } from "../components/islands/base-path.ts";
import { isImageIcon, isInlineSvg } from "../theme/icon-kind.ts";
import { resolveIcon } from "../theme/icons.ts";

/**
 * Resolve a `search.popular` icon to markup for the Cmd+K island. Accepts the
 * same *inputs* as nav `<Icon>` (built-in name, image path/URL, inline SVG);
 * resolved on the server so the island never loads the icon set.
 */
export const resolvePopularIconMarkup = (
  icon?: string,
  /** `deployment.base` / `import.meta.env.BASE_URL` for root-relative image paths. */
  base = "/"
): string | undefined => {
  if (!icon) {
    return undefined;
  }
  if (isInlineSvg(icon)) {
    // Author SVG carries no guaranteed width/height (a viewBox-only <svg>
    // defaults to 300x150), so size it the same way Icon.astro's wrapper does.
    return `<span aria-hidden="true" style="display:inline-flex;width:16px;height:16px">${icon.trim()}</span>`;
  }
  if (isImageIcon(icon)) {
    const src = prefixBase(base, icon.trim())
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    return `<img src="${src}" width="16" height="16" alt="" aria-hidden="true" class="size-4" />`;
  }
  const resolved = resolveIcon(icon);
  return resolved
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="${resolved.viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${resolved.body}</svg>`
    : undefined;
};
