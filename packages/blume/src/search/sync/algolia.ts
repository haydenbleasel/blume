import type { AlgoliaOptions } from "../adapters/algolia.ts";
import type { SearchRecord } from "../documents.ts";

/** The adapter options the sync reads (the public `apiKey` is never used). */
export type AlgoliaSyncConfig = Pick<AlgoliaOptions, "appId" | "indexName">;

/**
 * Upload the search records to Algolia. Uses the admin key from
 * `ALGOLIA_ADMIN_API_KEY` (never the adapter options, which hold only the
 * public, search-only key). Throws on a missing key so the caller can warn.
 *
 * Uses `replaceAllObjects`, which atomically replaces the index contents, so
 * pages deleted or renamed since the last sync don't linger as stale search
 * hits that 404 when clicked.
 */
export const syncAlgolia = async (
  records: SearchRecord[],
  config: AlgoliaSyncConfig
): Promise<void> => {
  const adminKey = process.env.ALGOLIA_ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error("ALGOLIA_ADMIN_API_KEY is not set.");
  }
  const { algoliasearch } = await import("algoliasearch");
  const client = algoliasearch(config.appId, adminKey);
  await client.replaceAllObjects({
    indexName: config.indexName,
    objects: records.map((record) => ({ ...record, objectID: record._id })),
  });
};
