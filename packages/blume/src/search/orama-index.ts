import { create, insertMultiple, search } from "@orama/orama";
import type { AnyOrama } from "@orama/orama";

/**
 * The minimal document shape both the client-side search dialog and the
 * server-side MCP `search_docs` tool index. Mirrors the `blume-search.json`
 * entries built by `buildSearchDocuments`.
 */
export interface OramaDoc {
  content: string;
  description: string;
  route: string;
  title: string;
}

const SCHEMA = {
  content: "string",
  description: "string",
  route: "string",
  title: "string",
} as const;

/** Title and description outrank body text, matching the search dialog. */
const BOOST = { description: 2, title: 3 };

/**
 * Build an in-memory Orama full-text index from search documents. Shared by the
 * Orama client loader (browser) and the MCP server (Node), so ranking is
 * identical wherever docs are queried.
 */
export const buildOramaIndex = async (
  documents: OramaDoc[]
): Promise<AnyOrama> => {
  const db = create({ schema: SCHEMA });
  await insertMultiple(db, documents);
  return db;
};

/** Query the index, returning the matching documents (highest-ranked first). */
export const queryOramaIndex = async (
  db: AnyOrama,
  term: string,
  limit: number
): Promise<OramaDoc[]> => {
  const found = await search(db, {
    boost: BOOST,
    limit,
    properties: ["title", "description", "content"],
    term,
  });
  return found.hits.map((hit) => hit.document as unknown as OramaDoc);
};
