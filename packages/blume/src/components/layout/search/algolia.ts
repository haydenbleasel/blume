import { liteClient } from "algoliasearch/lite";

import { excerptFor, highlight, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn } from "./types.ts";

interface AlgoliaRecord {
  url: string;
  title: string;
  description?: string;
  content?: string;
}

/**
 * Algolia: the browser queries the index directly with the public,
 * search-only key. Records are uploaded at build time by the sync step.
 */
export const createSearch = (opts: {
  appId: string;
  indexName: string;
  searchApiKey: string;
}): SearchFn => {
  const client = liteClient(opts.appId, opts.searchApiKey);
  return async (query) => {
    const { results } = await client.search<AlgoliaRecord>({
      requests: [
        { hitsPerPage: SEARCH_LIMIT, indexName: opts.indexName, query },
      ],
    });
    const [first] = results;
    const records =
      first && "hits" in first ? (first.hits as AlgoliaRecord[]) : [];
    const hits = records.map((record) => ({
      content: record.content ?? "",
      excerpt: highlight(
        excerptFor(record.description ?? "", record.content ?? "", query),
        query
      ),
      title: highlight(record.title, query),
      url: record.url,
    }));
    return { hits, sections: [] };
  };
};
