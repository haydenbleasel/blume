import { Client } from "typesense";

import type { TypesenseOptions } from "../../../search/adapters/typesense.ts";
import { excerptFor, highlight, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn } from "./types.ts";

interface TypesenseRecord extends Record<string, unknown> {
  url: string;
  title: string;
  description?: string;
  content?: string;
  version?: string;
}

/**
 * Typesense: the browser queries the collection directly with the search-only
 * key. Documents are imported at build time by the sync step. Every adapter
 * option Blume doesn't read (`connectionTimeoutSeconds`, `numRetries`, …) is
 * the site's own client option and goes to the `Client` untouched; the named
 * connection options still decide `apiKey` and `nodes`.
 */
export const createSearch = (opts: TypesenseOptions): SearchFn => {
  const { apiKey, collection, host, port, protocol, ...clientOptions } = opts;
  const client = new Client({
    ...clientOptions,
    apiKey,
    nodes: [{ host, port: port ?? 443, protocol: protocol ?? "https" }],
  });
  return async (query, options) => {
    const response = await client
      .collections<TypesenseRecord>(collection)
      .documents()
      .search(
        {
          per_page: SEARCH_LIMIT,
          q: query,
          query_by: "title,keywords,description,content",
          // Relevance first, in ten bands, then each page's `search.boost`
          // within a band: a boost lifts a page past similar matches without
          // floating it over clearly better ones.
          sort_by: "_text_match(buckets: 10):desc,boost:desc",
          // The sync marks `locale` and `version` as facets so hosted results
          // scope to the active language and the viewed docs version (the
          // current docs upload as "current").
          ...(() => {
            const clauses = [
              ...(options?.locale ? [`locale:=${options.locale}`] : []),
              ...(options?.version === undefined
                ? []
                : [`version:=${options.version || "current"}`]),
            ];
            return clauses.length > 0
              ? { filter_by: clauses.join(" && ") }
              : {};
          })(),
        },
        {}
      );
    const hits = (response.hits ?? []).map((hit) => {
      const doc = hit.document;
      return {
        content: doc.content ?? "",
        excerpt: highlight(
          excerptFor(doc.description ?? "", doc.content ?? "", query),
          query
        ),
        title: highlight(doc.title, query),
        url: doc.url,
        // Records store the current docs' version as "current" (hosted
        // backends treat empty facet values unreliably); the hit contract
        // uses "".
        version: doc.version === "current" ? "" : doc.version,
      };
    });
    return { hits, sections: [] };
  };
};
