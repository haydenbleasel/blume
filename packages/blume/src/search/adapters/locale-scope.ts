import type { SearchAdapterKind } from "./registry.ts";

/**
 * Whether each adapter's client can limit results to one language. The
 * source-built indexes (Orama, FlexSearch) store every document's `locale`,
 * the Algolia, Orama Cloud, and Typesense syncs upload it for their clients
 * to filter on, and Pagefind keeps an index per language, merging the others
 * in to search them all. The Mixedbread endpoint takes no filter, so it
 * always searches every language. Keyed by every kind so a new adapter has
 * to decide.
 */
const SCOPES_LOCALES = {
  algolia: true,
  flexsearch: true,
  mixedbread: false,
  none: false,
  orama: true,
  "orama-cloud": true,
  pagefind: true,
  typesense: true,
} satisfies Record<SearchAdapterKind, boolean>;

/**
 * Whether the configured search adapter scopes results to the page's
 * language. The search dialog offers its "All languages" toggle only when it
 * does: on the others the toggle would change nothing, and every query
 * already spans all languages.
 */
export const scopesLocales = (kind: SearchAdapterKind): boolean =>
  SCOPES_LOCALES[kind];
