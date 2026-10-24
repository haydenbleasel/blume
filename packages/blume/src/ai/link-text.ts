import { mountBasePath } from "../core/base-path.ts";
import { absoluteUrl } from "../core/site-url.ts";

/** `encodeURIComponent` leaves these as they are, so they're mapped here. */
const UNESCAPED = new Map([
  ["'", "%27"],
  ["(", "%28"],
  [")", "%29"],
]);

/**
 * An href as a Markdown link target: the characters that would end or split
 * a link destination or the attribute it's in (whitespace, quotes,
 * parentheses, angle brackets) are percent-encoded. The rest stays as
 * written, escapes included, so `/ja/ポイント` reads as it is.
 */
export const hrefTarget = (href: string): string =>
  href.replaceAll(
    /[\s"'()<>]/gu,
    (char) => UNESCAPED.get(char) ?? encodeURIComponent(char)
  );

/**
 * A page route as a link target: as {@link hrefTarget} writes an href, and
 * with any `%` encoded too, since one in a route would read as an escape.
 */
export const routeTarget = (route: string): string =>
  hrefTarget(route.replaceAll("%", "%25"));

/**
 * A page's URL in the lists agents read by URL (`llms.txt`, the site skill,
 * the changelog index): under `deployment.base` — with or without a `site`
 * (the mcp.json convention), and even over a route that starts with the
 * base's own name — and absolute under a configured `site`. Encoded like the
 * sitemap, so a route with spaces or non-ASCII still makes a valid Markdown
 * link, and as {@link hrefTarget}, so a quote or a parenthesis can't end it.
 */
export const pageUrl = (route: string, site?: string, base = ""): string => {
  const path = mountBasePath(base, route);
  return hrefTarget(encodeURI(site ? absoluteUrl(site, path) : path));
};

/**
 * A title as Markdown link text. An unescaped bracket in it — `[Beta] Webhooks`
 * — closes or nests the text early, and the line stops being a link; so does a
 * line break, which a folded YAML title (`title: >`) ends with, so whitespace
 * runs collapse to one space.
 */
export const linkText = (title: string): string =>
  title
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/[\\[\]]/gu, String.raw`\$&`);
