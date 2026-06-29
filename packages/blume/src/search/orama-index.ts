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
  /** Locale code; indexed as an enum so queries can filter to one language. */
  locale?: string;
  /** Carried through for the search dialog's breadcrumb + filter pills. Stored
   * but not indexed, so they ride along on the returned document untouched. */
  breadcrumb?: string[];
  section?: string;
}

const SCHEMA = {
  content: "string",
  description: "string",
  // Enum (not full-text "string") so `where` does an exact-match filter.
  locale: "enum",
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

/**
 * Query the index, returning the matching documents (highest-ranked first).
 * When `locale` is given, results are filtered to that language via an exact
 * `where` match on the `locale` enum.
 */
export const queryOramaIndex = async (
  db: AnyOrama,
  term: string,
  limit: number,
  locale?: string
): Promise<OramaDoc[]> => {
  const found = await search(db, {
    boost: BOOST,
    limit,
    properties: ["title", "description", "content"],
    term,
    ...(locale ? { where: { locale: { eq: locale } } } : {}),
  });
  return found.hits.map((hit) => hit.document as unknown as OramaDoc);
};
