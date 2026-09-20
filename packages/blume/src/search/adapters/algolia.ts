import { z } from "zod";

import type { JsonValue } from "../../core/adapter.ts";
import type { SearchAdapter } from "./types.ts";

/**
 * Public Algolia credentials. The browser queries the index with the
 * search-only `apiKey`; the build-time sync replaces the index with the admin
 * key from `ALGOLIA_ADMIN_API_KEY`, which never enters the config.
 */
export interface AlgoliaNamedOptions {
  appId: string;
  /** The search-only API key (public — it ships to the browser). */
  apiKey: string;
  indexName: string;
}

/**
 * Options for {@link algolia}: the named options plus any other client
 * option, forwarded to the browser verbatim. JSON values only.
 */
export type AlgoliaOptions = AlgoliaNamedOptions & {
  [option: string]: JsonValue;
};

export type AlgoliaAdapter = SearchAdapter<"algolia", "hosted", AlgoliaOptions>;

export const algoliaOptionsSchema = z
  .object({
    apiKey: z.string(),
    appId: z.string(),
    indexName: z.string(),
  })
  .catchall(z.json());

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
