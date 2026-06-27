import { OramaClient } from "@oramacloud/client";

import { excerptFor, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn } from "./types.ts";

interface OramaCloudRecord {
  url: string;
  title: string;
  description?: string;
  content?: string;
}

/**
 * Orama Cloud: the browser queries the hosted index directly with the public
 * endpoint + API key. Records are pushed at build time by the sync step.
 */
export const createSearch = (opts: {
  endpoint: string;
  apiKey: string;
}): SearchFn => {
  const client = new OramaClient({
    api_key: opts.apiKey,
    endpoint: opts.endpoint,
  });
  return async (query) => {
    const results = await client.search({ limit: SEARCH_LIMIT, term: query });
    const hits = results?.hits ?? [];
    return hits.map((hit) => {
      const doc = hit.document as unknown as OramaCloudRecord;
      return {
        excerpt: excerptFor(doc.description ?? "", doc.content ?? ""),
        title: doc.title,
        url: doc.url,
      };
    });
  };
};
