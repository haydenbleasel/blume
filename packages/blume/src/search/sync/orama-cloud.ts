import type { SearchRecord } from "../documents.ts";

export interface OramaCloudSyncConfig {
  indexId?: string;
}

/**
 * Push the search records to an Orama Cloud index via `CloudManager`, using the
 * private key from `ORAMA_PRIVATE_API_KEY`. Snapshots the full record set, then
 * deploys. Throws on a missing key/index so the caller can warn.
 */
export const syncOramaCloud = async (
  records: SearchRecord[],
  config: OramaCloudSyncConfig | undefined
): Promise<void> => {
  if (!config) {
    throw new Error("search.oramaCloud config is missing.");
  }
  if (!config.indexId) {
    throw new Error("search.oramaCloud.indexId is required to sync.");
  }
  const privateKey = process.env.ORAMA_PRIVATE_API_KEY;
  if (!privateKey) {
    throw new Error("ORAMA_PRIVATE_API_KEY is not set.");
  }
  const { CloudManager } = await import("@oramacloud/client");
  const manager = new CloudManager({ api_key: privateKey });
  const index = manager.index(config.indexId);
  await index.snapshot(
    records.map((record) => ({
      content: record.content,
      description: record.description,
      id: record._id,
      tag: record.tag,
      title: record.title,
      url: record.url,
    }))
  );
  await index.deploy();
};
