import { highlight, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn, SearchHit } from "./types.ts";

/**
 * Server-proxied search (Mixedbread): POST the query to a generated endpoint
 * that holds the secret key and talks to the service. The returned hits carry
 * service-derived text and the dialog injects title/excerpt as HTML, so both
 * are escaped (and query matches marked) here, like every other provider.
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
    // SAFETY: the endpoint is Blume-generated (`search-endpoint` template) and
    // responds with the SearchHit list it built; title/excerpt are still
    // escaped below before the dialog injects them as HTML.
    const records = (await response.json()) as SearchHit[];
    const hits = records.slice(0, SEARCH_LIMIT).map((hit) => ({
      ...hit,
      excerpt: highlight(hit.excerpt, query),
      title: highlight(hit.title, query),
    }));
    return { hits, sections: [] };
  };
