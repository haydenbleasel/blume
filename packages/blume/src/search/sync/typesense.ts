import type { SearchRecord } from "../documents.ts";

export interface TypesenseSyncConfig {
  collection: string;
  host: string;
  port?: number;
  protocol?: string;
}

/**
 * Import the search records into a Typesense collection. Uses the admin key
 * from `TYPESENSE_ADMIN_API_KEY`. Throws on a missing key/config so the caller
 * can warn.
 *
 * The collection is dropped and recreated on each sync so that pages deleted or
 * renamed since the last sync don't linger as stale search hits that 404 when
 * clicked (an upsert alone never removes them).
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

  const collection = client.collections(config.collection);
  let exists = true;
  try {
    await collection.retrieve();
  } catch {
    exists = false;
  }
  if (exists) {
    await collection.delete();
  }
  await client.collections().create({
    fields: [
      { name: "title", type: "string" },
      { name: "description", optional: true, type: "string" },
      { name: "content", type: "string" },
      { name: "url", type: "string" },
      { facet: true, name: "tag", optional: true, type: "string" },
      // Carried as facets so hosted results can filter per language and per
      // docs version (the SearchRecord contract; current docs = "current").
      { facet: true, name: "locale", optional: true, type: "string" },
      { facet: true, name: "version", optional: true, type: "string" },
    ],
    name: config.collection,
  });

  const documents = records.map((record) => ({
    content: record.content,
    description: record.description,
    id: record._id,
    locale: record.locale,
    tag: record.tag,
    title: record.title,
    url: record.url,
    version: record.version,
  }));
  await client
    .collections(config.collection)
    .documents()
    .import(documents, { action: "upsert" });
};
