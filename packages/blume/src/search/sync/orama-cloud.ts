import type { OramaCloudOptions } from "../adapters/orama-cloud.ts";
import type { SearchRecord } from "../documents.ts";

/** The adapter options the sync reads (the public credentials are never used). */
export type OramaCloudSyncConfig = Pick<OramaCloudOptions, "indexId">;

/**
 * Push the search records to an Orama Cloud index via `CloudManager`, using the
 * private key from `ORAMA_PRIVATE_API_KEY`. Snapshots the full record set, then
 * deploys. Throws on a missing key/index so the caller can warn.
 */
export const syncOramaCloud = async (
  records: SearchRecord[],
  config: OramaCloudSyncConfig
): Promise<void> => {
  if (!config.indexId) {
    throw new Error("oramaCloud({ indexId }) is required to sync.");
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
      // Carried so an i18n site can filter hosted results per language.
      locale: record.locale,
      tag: record.tag,
      title: record.title,
      url: record.url,
    }))
  );
  await index.deploy();
};
