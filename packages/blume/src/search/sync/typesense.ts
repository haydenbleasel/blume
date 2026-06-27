import type { SearchRecord } from "../documents.ts";

export interface TypesenseSyncConfig {
  collection: string;
  host: string;
  port?: number;
  protocol?: string;
}

/**
 * Import the search records into a Typesense collection, creating the
 * collection on first run. Uses the admin key from `TYPESENSE_ADMIN_API_KEY`.
 * Throws on a missing key/config so the caller can warn.
 */
export const syncTypesense = async (
  records: SearchRecord[],
  config: TypesenseSyncConfig | undefined
): Promise<void> => {
  if (!config) {
    throw new Error("search.typesense config is missing.");
  }
  const adminKey = process.env.TYPESENSE_ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error("TYPESENSE_ADMIN_API_KEY is not set.");
  }
  const { Client } = await import("typesense");
  const client = new Client({
    apiKey: adminKey,
    nodes: [
      {
        host: config.host,
        port: config.port ?? 443,
        protocol: config.protocol ?? "https",
      },
    ],
  });

  try {
    await client.collections(config.collection).retrieve();
  } catch {
    await client.collections().create({
      fields: [
        { name: "title", type: "string" },
        { name: "description", optional: true, type: "string" },
        { name: "content", type: "string" },
        { name: "url", type: "string" },
        { facet: true, name: "tag", optional: true, type: "string" },
      ],
      name: config.collection,
    });
  }

  const documents = records.map((record) => ({
    content: record.content,
    description: record.description,
    id: record._id,
    tag: record.tag,
    title: record.title,
    url: record.url,
  }));
  await client
    .collections(config.collection)
    .documents()
    .import(documents, { action: "upsert" });
};
