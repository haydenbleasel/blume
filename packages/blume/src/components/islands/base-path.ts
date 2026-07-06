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

/**
 * Prefix a root-relative internal route with the deployment base
 * (`/guide` under base `/sub` -> `/sub/guide`), so a rendered link points at the
 * page's real served URL. External URLs, protocol-relative URLs, and fragments
 * pass through untouched, and it's idempotent (a route already under the base is
 * returned unchanged). This is applied only where a URL is *emitted* — the
 * navigation model and active-route matching stay in base-less logical space.
 */
export const prefixBase = (base: string, route: string): string => {
  if (!route.startsWith("/") || route.startsWith("//")) {
    return route;
  }
  const trimmed = base.replace(/\/+$/u, "");
  if (!trimmed || route === trimmed || route.startsWith(`${trimmed}/`)) {
    return route;
  }
  return route === "/" ? trimmed : `${trimmed}${route}`;
};

/**
 * {@link prefixBase} bound to the build-time `BASE_URL` (the resolved
 * `deployment.base`). The ergonomic form for `.astro` templates — `href={
 * withBase(route)}` — since `BASE_URL` is inlined by Vite wherever this module
 * is bundled into the site.
 */
export const withBase = (route: string): string =>
  prefixBase(import.meta.env.BASE_URL ?? "/", route);

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
