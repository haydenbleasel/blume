import { Client } from "typesense";

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
 * key. Documents are imported at build time by the sync step.
 */
export const createSearch = (opts: {
  collection: string;
  host: string;
  port?: number;
  protocol?: string;
  searchApiKey: string;
}): SearchFn => {
  const client = new Client({
    apiKey: opts.searchApiKey,
    nodes: [
      {
        host: opts.host,
        port: opts.port ?? 443,
        protocol: opts.protocol ?? "https",
      },
    ],
  });
  return async (query, options) => {
    const response = await client
      .collections<TypesenseRecord>(opts.collection)
      .documents()
      .search(
        {
          per_page: SEARCH_LIMIT,
          q: query,
          query_by: "title,description,content",
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
