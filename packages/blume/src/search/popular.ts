import { withBasePath } from "../core/base-path.ts";

/** A resolved search empty-state link passed to the Search dialog. */
export interface SearchPopularPage {
  label: string;
  route: string;
}

/**
 * Map configured `search.popular` entries to `{ route, label }` for Search.
 *
 * Curated hrefs are authored as if mounted at root, so `basePath` is applied
 * here — matching `navigation.featured` and tab paths, and agreeing with the
 * sidebar fallback these entries replace (whose routes are already based via
 * `page.route`). `withBasePath` is idempotent and skips external URLs.
 *
 * `deployment.base` is deliberately *not* applied: routes stay deploy-base-less
 * so `createLinkRow` can prefix it at click time, same as sidebar-derived pages.
 */
export const resolveSearchPopular = (
  popular: { href: string; label: string }[],
  basePath: string
): SearchPopularPage[] =>
  popular.map(({ href, label }) => ({
    label,
    route: withBasePath(basePath, href),
  }));
