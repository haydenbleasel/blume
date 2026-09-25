/**
 * Base-path helpers for client islands. Astro's default `trailingSlash:
 * "ignore"` passes `deployment.base` through as-is, so `BASE_URL` may arrive
 * with or without a trailing slash (`/docs` or `/docs/`); every consumer must
 * treat both forms the same or endpoints/grounding break under a base path.
 */

/** The base with a guaranteed trailing slash (`/docs` -> `/docs/`). */
export const withTrailingSlash = (base: string): string =>
  base.endsWith("/") ? base : `${base}/`;

/** Join a base-relative path (`api/ask`) onto the deployment base. */
export const joinBase = (base: string, path: string): string =>
  `${withTrailingSlash(base)}${path}`;

/** A root-relative internal target (`/x`) — never `//host` or a URL. */
const isRootRelative = (route: string): boolean =>
  route.startsWith("/") && !route.startsWith("//");

/** A target's path, without its `?query` or `#fragment`. */
const pathOf = (route: string): string => {
  const at = route.search(/[#?]/u);
  return at === -1 ? route : route.slice(0, at);
};

/**
 * Prefix a root-relative internal link an author wrote with the deployment
 * base (`/guide` under base `/sub` -> `/sub/guide`), so it points at the
 * page's real served URL. External URLs, protocol-relative URLs, and fragments
 * pass through untouched, and it's idempotent: a link whose path is already
 * under the base (`/sub/guide`, `/sub#install`) is returned unchanged, so a
 * base written by hand isn't doubled. A route Blume generates takes
 * {@link mountBase} instead. This is applied only where a URL is *emitted* —
 * the navigation model and active-route matching stay in base-less logical
 * space.
 */
export const prefixBase = (base: string, route: string): string => {
  if (!isRootRelative(route)) {
    return route;
  }
  const trimmed = base.replace(/\/+$/u, "");
  const path = pathOf(route);
  if (!trimmed || path === trimmed || path.startsWith(`${trimmed}/`)) {
    return route;
  }
  return route === "/" ? trimmed : `${trimmed}${route}`;
};

/**
 * Prefix a route Blume generates (a page, a sidebar entry, a Markdown mirror,
 * an agent artifact) with the deployment base, unconditionally. Unlike
 * {@link prefixBase}, a route whose first segment matches the base is still
 * prefixed: under base `/guides`, the page `guides/setup.md` is served at
 * `/guides/guides/setup`, not at `/guides/setup`. External and
 * protocol-relative URLs pass through untouched.
 */
export const mountBase = (base: string, route: string): string => {
  const trimmed = base.replace(/\/+$/u, "");
  if (!(trimmed && isRootRelative(route))) {
    return route;
  }
  return route === "/" ? trimmed : `${trimmed}${route}`;
};

/**
 * {@link prefixBase} bound to the build-time `BASE_URL` (the resolved
 * `deployment.base`), for links an author wrote. The ergonomic form for
 * `.astro` templates — `href={withBase(href)}` — since `BASE_URL` is inlined
 * by Vite wherever this module is bundled into the site.
 */
export const withBase = (route: string): string =>
  prefixBase(import.meta.env.BASE_URL ?? "/", route);

/**
 * {@link mountBase} bound to the build-time `BASE_URL`, for routes Blume
 * generates: `href={withMountedBase(page.route)}`.
 */
export const withMountedBase = (route: string): string =>
  mountBase(import.meta.env.BASE_URL ?? "/", route);

/**
 * A pathname with the deployment base stripped (`/docs/guide` -> `/guide`),
 * for page-context lookups against base-less document routes.
 */
export const stripBase = (base: string, pathname: string): string => {
  const slashed = withTrailingSlash(base);
  if (slashed === "/") {
    return pathname;
  }
  if (pathname.startsWith(slashed)) {
    return `/${pathname.slice(slashed.length)}`;
  }
  // The bare base itself ("/docs") is the base-less root.
  return `${pathname}/` === slashed ? "/" : pathname;
};
