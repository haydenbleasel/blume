import { SEARCH_LIMIT } from "./types.ts";
import type { SearchFn, SearchHit } from "./types.ts";

/**
 * Server-proxied search (Mixedbread): POST the query to a generated endpoint
 * that holds the secret key and talks to the service, then renders the
 * already-shaped hits it returns.
 */
export const createSearch =
  (opts: { api: string }): SearchFn =>
  async (query) => {
    const response = await fetch(opts.api, {
      body: JSON.stringify({ query }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      return { hits: [], sections: [] };
    }
    const hits = (await response.json()) as SearchHit[];
    return { hits: hits.slice(0, SEARCH_LIMIT), sections: [] };
  };
