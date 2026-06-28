import {
  buildOramaIndex,
  queryOramaIndex,
} from "../../../search/orama-index.ts";
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
  const db = await buildOramaIndex(documents);

  return async (query) => {
    const docs = await queryOramaIndex(db, query, SEARCH_LIMIT);
    return docs.map((doc) => ({
      excerpt: excerptFor(doc.description, doc.content),
      title: doc.title,
      url: doc.route,
    }));
  };
};
