/**
 * The site-wide `basePath` — a mount point that prepends a segment to every
 * generated route (`/docs/getting-started`) while staying invisible to the
 * navigation tree (see `core/navigation.ts`, which builds groups from a page's
 * base-less `navPath` and takes URLs from its based `route`). This is distinct
 * from a per-source `prefix` (a namespace that *does* create a sidebar group)
 * and from `deployment.base` (Astro's host-subdirectory base); the two compose,
 * stacking as `{deployment.base}/{basePath}/page`.
 *
 * These helpers run server-side (config, route construction, the link checker,
 * redirects, the markdown link plugin). The client-side counterpart lives in
 * `components/islands/base-path.ts` and serves `deployment.base` via `BASE_URL`.
 */

import { trimEnd } from "./trim.ts";

/**
 * Canonicalize a configured base path to either `""` (none) or `/seg[/seg…]`
 * (leading slash, no trailing slash, collapsed inner slashes). A blank value or
 * bare `/` normalizes to `""`, so an unset/`"/"` base is a clean no-op.
 */
export const normalizeBasePath = (input?: string): string => {
  if (!input) {
    return "";
  }
  // Splitting on "/" and dropping the empty parts trims the edges and collapses
  // inner runs in one linear pass; the regex spellings of both are quadratic on
  // a long run of slashes (see `core/trim.ts`).
  const trimmed = input.trim().split("/").filter(Boolean).join("/");
  return trimmed === "" ? "" : `/${trimmed}`;
};

/**
 * Normalize a served path for comparison: drop the trailing slash (Astro serves
 * `/docs` and `/docs/` as the same page) and collapse an empty path to `/`.
 */
export const normalizePath = (path: string): string => {
  const trimmed = trimEnd(path, "/");
  return trimmed === "" ? "/" : trimmed;
};

/**
 * Canonicalize a route-ish string (a configured route, a page path, an agent-
 * supplied route) to `/` or `/seg[/seg…]`: trimmed, exactly one leading slash,
 * no trailing slash. The shared spelling of what openapi/references,
 * ai/ask-context, and ai/mcp/server each hand-rolled with slightly different
 * regexes.
 */
export const normalizeRoute = (input: string): string => {
  const trimmed = trimEnd(input.trim(), "/");
  if (trimmed === "") {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

/**
 * Whether a link target is a root-relative internal path (`/x`) — the only
 * shape a base path applies to. Protocol-relative (`//host`), absolute URLs,
 * other schemes (`mailto:`), fragments (`#x`), and relative paths are excluded.
 */
export const isInternalPath = (target: string): boolean =>
  target.startsWith("/") && !target.startsWith("//");

/**
 * Whether a rendered link should open in a new tab: an absolute http(s) URL or
 * a protocol-relative one (`//host/path`). Other schemes (`mailto:`, `tel:`)
 * also leave the site but hand off to another application, where a `_blank`
 * target only opens an empty tab beside it. The one predicate behind every
 * chrome link, so a header action and a sidebar featured link treat the same
 * href alike.
 */
export const isExternalUrl = (target: string): boolean =>
  /^https?:\/\//iu.test(target) || target.startsWith("//");

/**
 * The path part of a root-relative target, before any `?query` or `#fragment`
 * (`/docs#install` -> `/docs`).
 */
const pathPart = (target: string): string => {
  const at = target.search(/[#?]/u);
  return at === -1 ? target : target.slice(0, at);
};

/**
 * Whether `route`'s path already equals or sits under `base`. Only the path
 * part is compared, so a fragment or query (`/docs#install`) doesn't hide a
 * base written by hand.
 */
const isUnderBase = (base: string, route: string): boolean => {
  const path = pathPart(route);
  return path === base || path.startsWith(`${base}/`);
};

/**
 * Idempotently prepend `basePath` to a root-relative route. A route already
 * equal to or nested under the base is returned unchanged, so authors who write
 * the base by hand (`/docs/x`, `/docs#install`) aren't double-prefixed to
 * `/docs/docs/x`.
 */
export const withBasePath = (basePath: string, route: string): string => {
  if (!basePath || !isInternalPath(route) || isUnderBase(basePath, route)) {
    return route;
  }
  return route === "/" ? basePath : `${basePath}${route}`;
};

/**
 * Mount a route Blume generates under a base, unconditionally: `basePath` for
 * a content route, `deployment.base` for any generated URL (a sitemap entry,
 * a feed item). {@link withBasePath} leaves a route that already starts with
 * the base alone, which is right for a link an author based by hand but wrong
 * for a generated route: with `basePath: "/docs"`, `docs/guide.md` routes to
 * `/docs/guide` before the base and publishes at `/docs/docs/guide`, not on
 * top of the root `guide.md` — and likewise under `deployment.base: "/docs"`.
 */
export const mountBasePath = (basePath: string, route: string): string => {
  if (!basePath) {
    return route;
  }
  return route === "/" ? basePath : `${basePath}${route}`;
};

/**
 * {@link withBasePath} for the composed `deployment.base` + `basePath` stack
 * (`/base` + `/docs` serves pages at `/base/docs/x`). The hand-written-base
 * promise applies per layer: authors write `basePath` by hand (see
 * `markdown/base-links.ts`), so a `/docs/x` link gains only the deployment base
 * (`/base/docs/x`) rather than being double-prefixed to `/base/docs/docs/x`,
 * and a route already under the full composite is returned unchanged.
 */
export const withComposedBasePath = (
  deployBase: string,
  basePath: string,
  route: string
): string => {
  const composed = `${deployBase}${basePath}`;
  if (composed && isInternalPath(route) && isUnderBase(composed, route)) {
    return route;
  }
  return withBasePath(deployBase, withBasePath(basePath, route));
};

/**
 * A path whose final segment carries a file extension (`/spec.pdf`,
 * `/logo.svg`) — a public asset, unless a page is served there.
 */
const DOTTED_PATH = /\.[a-z0-9]+$/iu;

/**
 * Base a root-relative link an author wrote as if mounted at root — a content
 * link (`markdown/base-links.ts`, `components/content/base-href.ts`) or a
 * redirect target (`deploy/redirects.ts`) — by what it names. A page gains the
 * composed stack ({@link withComposedBasePath}). A public asset — a path whose
 * final segment carries a file extension, with no page served there (a dotted
 * route like `/releases/v1.2` is still a page) — gains the deployment base
 * alone: Astro serves `public/` under `deployment.base`, but never under
 * `basePath`. `servesPage` answers whether a page is served at a
 * `basePath`-prefixed, fragment-less path. Other targets pass through.
 */
export const withAuthoredBasePath = (
  deployBase: string,
  basePath: string,
  target: string,
  servesPage: (route: string) => boolean
): string => {
  if (!isInternalPath(target)) {
    return target;
  }
  const path = pathPart(target);
  return DOTTED_PATH.test(path) && !servesPage(withBasePath(basePath, path))
    ? withBasePath(deployBase, target)
    : withComposedBasePath(deployBase, basePath, target);
};

/**
 * Remove `basePath` from the front of a route (`/docs/guide` -> `/guide`,
 * `/docs` -> `/`). A route not under the base is returned unchanged. Inverse of
 * {@link withBasePath}; used to resolve public assets, which live at the site
 * root regardless of the base.
 */
export const stripBasePath = (basePath: string, route: string): string => {
  if (!basePath) {
    return route;
  }
  if (route === basePath) {
    return "/";
  }
  return route.startsWith(`${basePath}/`)
    ? route.slice(basePath.length)
    : route;
};
