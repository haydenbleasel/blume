import { liteClient } from "algoliasearch/lite";

import { excerptFor, highlight, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn } from "./types.ts";

interface AlgoliaRecord {
  url: string;
  title: string;
  description?: string;
  content?: string;
  version?: string;
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
  return async (query, options) => {
    const { results } = await client.search<AlgoliaRecord>({
      requests: [
        {
          hitsPerPage: SEARCH_LIMIT,
          indexName: opts.indexName,
          query,
          // The sync uploads `locale` and `version` on every record so a
          // site can scope hosted results to the active language and the
          // viewed docs version (the current docs upload as "current").
          ...(() => {
            const facetFilters = [
              ...(options?.locale ? [`locale:${options.locale}`] : []),
              ...(options?.version === undefined
                ? []
                : [`version:${options.version || "current"}`]),
            ];
            return facetFilters.length > 0 ? { facetFilters } : {};
          })(),
        },
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
      // Records store the current docs' version as "current" (hosted backends
      // treat empty facet values unreliably); the hit contract uses "".
      version: record.version === "current" ? "" : record.version,
    }));
    return { hits, sections: [] };
  };
};
