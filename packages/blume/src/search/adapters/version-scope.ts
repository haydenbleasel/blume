import type { SearchAdapterKind } from "./registry.ts";

/**
 * Whether each adapter's client can filter results to one docs version. The
 * source-built indexes (Orama, FlexSearch) store every document's `version`,
 * and the Algolia and Typesense syncs upload it as a facet their clients
 * filter on. Pagefind indexes the built HTML with no version metadata, the
 * Orama Cloud sync uploads no `version`, and the Mixedbread endpoint takes no
 * filter, so those always search every version. Keyed by every kind so a new
 * adapter has to decide.
 */
const SCOPES_VERSIONS = {
  algolia: true,
  flexsearch: true,
  mixedbread: false,
  none: false,
  orama: true,
  "orama-cloud": false,
  pagefind: false,
  typesense: true,
} satisfies Record<SearchAdapterKind, boolean>;

/**
 * Whether the configured search adapter scopes results to the viewed docs
 * version. The search dialog offers its "All versions" toggle only when it
 * does: on the others the toggle would change nothing, and every query
 * already spans all versions.
 */
export const scopesVersions = (kind: SearchAdapterKind): boolean =>
  SCOPES_VERSIONS[kind];
