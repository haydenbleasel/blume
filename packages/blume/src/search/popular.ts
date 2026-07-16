/** A resolved search empty-state link passed to the Search dialog. */
export interface SearchPopularPage {
  label: string;
  route: string;
}

/**
 * Map configured `search.popular` entries to `{ route, label }` for Search.
 * Routes stay base-less — `createLinkRow` applies `prefixBase` at click time,
 * same as sidebar-derived popular pages.
 */
export const resolveSearchPopular = (
  popular: { href: string; label: string }[]
): SearchPopularPage[] =>
  popular.map(({ href, label }) => ({
    label,
    route: href,
  }));
