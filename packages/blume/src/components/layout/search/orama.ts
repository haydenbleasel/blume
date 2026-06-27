import { create, insertMultiple, search } from "@orama/orama";

import { excerptFor, SEARCH_LIMIT } from "./types.ts";
import type { IndexedDocument, SearchFn } from "./types.ts";

/**
 * Orama (default): fetch the static `blume-search.json` index, build an
 * in-memory full-text database in the browser, and query it. Keyless and
 * available in both dev and the production build.
 */
export const createSearch = async (opts: {
  indexUrl: string;
}): Promise<SearchFn> => {
  const response = await fetch(opts.indexUrl);
  const documents = (await response.json()) as IndexedDocument[];
  const db = create({
    schema: {
      content: "string",
      description: "string",
      route: "string",
      title: "string",
    },
  });
  await insertMultiple(db, documents);

  return async (query) => {
    const found = await search(db, {
      boost: { description: 2, title: 3 },
      limit: SEARCH_LIMIT,
      properties: ["title", "description", "content"],
      term: query,
    });
    return found.hits.map((hit) => {
      const doc = hit.document as unknown as IndexedDocument;
      return {
        excerpt: excerptFor(doc.description, doc.content),
        title: doc.title,
        url: doc.route,
      };
    });
  };
};
