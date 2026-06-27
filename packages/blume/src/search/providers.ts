import type { SearchProvider } from "../core/schema.ts";

/**
 * How a search provider integrates with the generated runtime.
 *
 * - `static` providers ship a client-side index (`blume-search.json`) that the
 *   browser loads and queries — `orama`, `flexsearch`.
 * - `pagefind` builds its own index from the rendered HTML after the Astro build.
 * - `hosted` providers are queried directly from the browser against an external
 *   service, with a build-time sync uploading the index — `algolia`,
 *   `orama-cloud`, `typesense`.
 * - `server` providers proxy queries through a generated `/api/search` endpoint
 *   that holds a secret key, so they require server output — `mixedbread`.
 */
export type SearchProviderKind =
  | "static"
  | "pagefind"
  | "hosted"
  | "server"
  | "none";

export interface SearchProviderMeta {
  kind: SearchProviderKind;
  /** Extra packages the generated `.blume/package.json` must declare. */
  runtimeDeps: string[];
  /** Whether the provider needs `deployment.output: "server"`. */
  requiresServer: boolean;
  /** Whether a build-time sync uploads the index to an external service. */
  syncs: boolean;
}

export const SEARCH_PROVIDERS: Record<SearchProvider, SearchProviderMeta> = {
  algolia: {
    kind: "hosted",
    requiresServer: false,
    runtimeDeps: ["algoliasearch"],
    syncs: true,
  },
  flexsearch: {
    kind: "static",
    requiresServer: false,
    runtimeDeps: ["flexsearch"],
    syncs: false,
  },
  mixedbread: {
    // Content is synced to the store out-of-band via the `mxbai` CLI, not by an
    // in-process build step.
    kind: "server",
    requiresServer: true,
    runtimeDeps: ["@mixedbread/sdk"],
    syncs: false,
  },
  none: {
    kind: "none",
    requiresServer: false,
    runtimeDeps: [],
    syncs: false,
  },
  orama: {
    kind: "static",
    requiresServer: false,
    runtimeDeps: ["@orama/orama"],
    syncs: false,
  },
  "orama-cloud": {
    kind: "hosted",
    requiresServer: false,
    runtimeDeps: ["@oramacloud/client"],
    syncs: true,
  },
  pagefind: {
    kind: "pagefind",
    requiresServer: false,
    runtimeDeps: [],
    syncs: false,
  },
  typesense: {
    kind: "hosted",
    requiresServer: false,
    runtimeDeps: ["typesense"],
    syncs: true,
  },
};

export const searchProviderMeta = (
  provider: SearchProvider
): SearchProviderMeta => SEARCH_PROVIDERS[provider];

/** Whether a provider ships a client-loaded `blume-search.json` index. */
export const servesStaticIndex = (provider: SearchProvider): boolean =>
  SEARCH_PROVIDERS[provider].kind === "static";
