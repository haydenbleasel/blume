import { Client } from "typesense";

import { excerptFor, highlight, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn } from "./types.ts";

interface TypesenseRecord extends Record<string, unknown> {
  url: string;
  title: string;
  description?: string;
  content?: string;
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
  return async (query) => {
    const response = await client
      .collections<TypesenseRecord>(opts.collection)
      .documents()
      .search(
        {
          per_page: SEARCH_LIMIT,
          q: query,
          query_by: "title,description,content",
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
      };
    });
    return { hits, sections: [] };
  };
};
