import { z } from "zod";

import type { SearchAdapter } from "./types.ts";

/**
 * Public Algolia credentials. The browser queries the index with the
 * search-only `apiKey`; the build-time sync replaces the index with the admin
 * key from `ALGOLIA_ADMIN_API_KEY`, which never enters the config.
 */
export interface AlgoliaOptions {
  appId: string;
  /** The search-only API key (public — it ships to the browser). */
  apiKey: string;
  indexName: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- mirrors the schema's `looseObject` (the drift guard requires it); extra options pass through to the client verbatim
  [option: string]: unknown;
}

export type AlgoliaAdapter = SearchAdapter<"algolia", "hosted", AlgoliaOptions>;

export const algoliaOptionsSchema = z.looseObject({
  apiKey: z.string(),
  appId: z.string(),
  indexName: z.string(),
});

/**
 * Hosted search on Algolia. Each `blume build` replaces the whole index with
 * the current records, so deleted or renamed pages don't linger as stale hits.
 */
export const algolia = (options: AlgoliaOptions): AlgoliaAdapter => ({
  kind: "algolia",
  mode: "hosted",
  options,
  requiredSecrets: [],
  runtimeDeps: ["algoliasearch"],
});
