import {
  buildOramaIndex,
  queryOramaIndex,
} from "../../../search/orama-index.ts";
import { buildResult, RESULT_POOL } from "./types.ts";
import type { IndexedDocument, SearchFn } from "./types.ts";

/**
 * Orama (default): fetch the static `blume-search.json` index, build an
 * in-memory full-text database in the browser, and query it. Keyless and
 * available in both dev and the production build. A generous match pool is
 * pulled so the section pills can count across the whole result set before the
 * active filter and display limit are applied.
 */
export const createSearch = async (opts: {
  indexUrl: string;
}): Promise<SearchFn> => {
  const response = await fetch(opts.indexUrl);
  const documents = (await response.json()) as IndexedDocument[];
  const db = await buildOramaIndex(documents);

  return async (query, options) => {
    const docs = await queryOramaIndex(db, query, RESULT_POOL, options?.locale);
    return buildResult(docs as IndexedDocument[], query, options?.section);
  };
};
