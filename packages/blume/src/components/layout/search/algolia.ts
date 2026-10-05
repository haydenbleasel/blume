import { liteClient } from "algoliasearch/lite";

import type { AlgoliaOptions } from "../../../search/adapters/algolia.ts";
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
 * search-only key. Records are uploaded at build time by the sync step. Every
 * adapter option Blume doesn't read (`hosts`, `timeouts`, `baseHeaders`, …) is
 * the site's own client option and goes to `liteClient` untouched.
 */
export const createSearch = (opts: AlgoliaOptions): SearchFn => {
  const { apiKey, appId, indexName, ...clientOptions } = opts;
  const client = liteClient(appId, apiKey, clientOptions);
  return async (query, options) => {
    const { results } = await client.search<AlgoliaRecord>({
      requests: [
        {
          hitsPerPage: SEARCH_LIMIT,
          indexName,
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
    // SAFETY: the build-time sync uploads every record in the AlgoliaRecord
    // shape, so hits returned by that index carry those fields.
    const records =
      first && "hits" in first ? (first.hits as AlgoliaRecord[]) : [];
    // The sync splits a long page across records that share its `url`. The
    // index's `distinct` returns one of them, unless the site set its own
    // `attributeForDistinct`; either way a page is listed once.
    const pages = new Set<string>();
    const unique = records.filter((record) => {
      const seen = pages.has(record.url);
      pages.add(record.url);
      return !seen;
    });
    const hits = unique.map((record) => ({
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
