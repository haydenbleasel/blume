import type * as TypesenseSdk from "typesense";

import { nodeRequire } from "../../core/node-require.ts";
import type { TypesenseOptions } from "../adapters/typesense.ts";
import type { SearchRecord } from "../documents.ts";

/** The adapter options the sync reads (the public `apiKey` is never used). */
export type TypesenseSyncConfig = Pick<
  TypesenseOptions,
  "collection" | "host" | "locale" | "port" | "protocol"
>;

type TypesenseClient = InstanceType<typeof TypesenseSdk.Client>;

/**
 * The collection an alias points at, or `undefined` when there is no such
 * alias. Only a 404 means that: any other failure (a key that can't read
 * aliases, an outage) throws before the sync has touched anything.
 */
const aliasTarget = async (
  client: TypesenseClient,
  alias: string,
  errors: typeof TypesenseSdk.Errors
): Promise<string | undefined> => {
  try {
    const { collection_name: target } = await client.aliases(alias).retrieve();
    return target;
  } catch (error) {
    if (error instanceof errors.ObjectNotFound) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Import the search records into Typesense. Uses the admin key from
 * `TYPESENSE_ADMIN_API_KEY`. Throws on a missing key so the caller can warn.
 *
 * `collection` names an alias. Each sync imports every record into a new
 * collection (`<collection>_<timestamp>`), points the alias at it, then drops
 * the collection it replaced: searches keep reading the previous collection
 * until the new one is complete, pages deleted or renamed since the last sync
 * don't linger as stale hits that 404 when clicked, and a sync that fails
 * leaves the previous collection serving. A collection named `collection`
 * itself, from a sync before the alias existed, is dropped just before the
 * alias takes its name, since Typesense won't let the two share one.
 */
export const syncTypesense = async (
  records: SearchRecord[],
  config: TypesenseSyncConfig
): Promise<void> => {
  const adminKey = process.env.TYPESENSE_ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error("TYPESENSE_ADMIN_API_KEY is not set.");
  }
  // `require`, not `import()`: this runs in `astro:build:done` (see
  // `core/node-require.ts`).
  const { Client, Errors }: typeof TypesenseSdk = nodeRequire("typesense");
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

  const alias = config.collection;
  const previous = await aliasTarget(client, alias, Errors);
  const name = `${alias}_${Date.now()}`;
  // The searched text fields, tokenized for `locale` when the site sets one.
  const text = config.locale ? { locale: config.locale } : {};
  await client.collections().create({
    fields: [
      { name: "title", type: "string", ...text },
      { name: "description", optional: true, type: "string", ...text },
      { name: "content", type: "string", ...text },
      { name: "url", type: "string" },
      { name: "keywords", optional: true, type: "string[]", ...text },
      // The dialog sorts close matches by it (search.boost, 1 by default).
      { name: "boost", type: "float" },
      { facet: true, name: "tag", optional: true, type: "string" },
      // Carried as facets so hosted results can filter per language and per
      // docs version (the SearchRecord contract; current docs = "current").
      { facet: true, name: "locale", optional: true, type: "string" },
      { facet: true, name: "version", optional: true, type: "string" },
    ],
    name,
  });

  const documents = records.map((record) => ({
    boost: record.boost,
    content: record.content,
    description: record.description,
    id: record._id,
    keywords: record.keywords ?? [],
    locale: record.locale,
    tag: record.tag,
    title: record.title,
    url: record.url,
    version: record.version,
  }));
  try {
    await client
      .collections(name)
      .documents()
      .import(documents, { action: "upsert" });
  } catch (error) {
    // Nothing reads the new collection yet: drop it, and the alias keeps
    // serving the last complete sync.
    await client.collections(name).delete();
    throw error;
  }

  if (previous === undefined) {
    let legacy = true;
    try {
      await client.collections(alias).retrieve();
    } catch {
      legacy = false;
    }
    if (legacy) {
      await client.collections(alias).delete();
    }
  }
  await client.aliases().upsert(alias, { collection_name: name });
  if (previous !== undefined) {
    await client.collections(previous).delete();
  }
};
