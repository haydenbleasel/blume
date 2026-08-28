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
 * Idempotently prepend `basePath` to a root-relative route. A route already
 * equal to or nested under the base is returned unchanged, so authors who write
 * the base by hand (`/docs/x`) aren't double-prefixed to `/docs/docs/x`.
 */
export const withBasePath = (basePath: string, route: string): string => {
  if (!basePath || !isInternalPath(route)) {
    return route;
  }
  if (route === basePath || route.startsWith(`${basePath}/`)) {
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
  if (
    composed &&
    isInternalPath(route) &&
    (route === composed || route.startsWith(`${composed}/`))
  ) {
    return route;
  }
  return withBasePath(deployBase, withBasePath(basePath, route));
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
