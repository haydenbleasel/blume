/**
 * Search adapters for `blume.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { algolia } from "blume/search";
 *
 * export default defineConfig({
 *   search: algolia({ appId: "…", apiKey: "…", indexName: "docs" }),
 * });
 * ```
 *
 * Each factory returns a plain, JSON-serializable descriptor — never a live
 * client — that the generated runtime inlines as a literal.
 */
export { algolia } from "./algolia.ts";
export type { AlgoliaAdapter, AlgoliaOptions } from "./algolia.ts";
export { flexsearch } from "./flexsearch.ts";
export type { FlexsearchAdapter, FlexsearchOptions } from "./flexsearch.ts";
export { mixedbread } from "./mixedbread.ts";
export type { MixedbreadAdapter, MixedbreadOptions } from "./mixedbread.ts";
export { orama } from "./orama.ts";
export type { OramaAdapter, OramaOptions } from "./orama.ts";
export { oramaCloud } from "./orama-cloud.ts";
export type { OramaCloudAdapter, OramaCloudOptions } from "./orama-cloud.ts";
export { pagefind } from "./pagefind.ts";
export type { PagefindAdapter, PagefindOptions } from "./pagefind.ts";
export type {
  AnySearchAdapter,
  ResolvedSearchAdapter,
  SearchAdapterKind,
} from "./registry.ts";
export type {
  KeylessSearchOptions,
  SearchAdapter,
  SearchAdapterMode,
} from "./types.ts";
export { typesense } from "./typesense.ts";
export type { TypesenseAdapter, TypesenseOptions } from "./typesense.ts";
