import { Document } from "flexsearch";

import { excerptFor, SEARCH_LIMIT } from "./types.ts";
import type { IndexedDocument, SearchFn, SearchHit } from "./types.ts";

/**
 * FlexSearch: reuse the same static `blume-search.json` Orama ships, but build
 * a FlexSearch document index in the browser. Keyless; works in dev and build.
 * Results are looked up from a route→document map so we never depend on the
 * `enrich` result typing.
 */
export const createSearch = async (opts: {
  indexUrl: string;
}): Promise<SearchFn> => {
  const response = await fetch(opts.indexUrl);
  const documents = (await response.json()) as IndexedDocument[];
  const byRoute = new Map(documents.map((doc) => [doc.route, doc]));

  const index = new Document({
    document: { id: "route", index: ["title", "description", "content"] },
    tokenize: "forward",
  });
  for (const doc of documents) {
    // FlexSearch's `DocumentData` is an index-signature type; our concrete
    // record satisfies it structurally but TS needs the cast.
    index.add(doc as unknown as Record<string, string>);
  }

  // FlexSearch's in-memory search is synchronous, so the SearchFn resolves
  // immediately rather than awaiting anything.
  return (query) => {
    const groups = index.search(query, { limit: SEARCH_LIMIT });
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const id of group.result) {
        const route = String(id);
        if (seen.has(route)) {
          continue;
        }
        seen.add(route);
        const doc = byRoute.get(route);
        if (doc) {
          hits.push({
            excerpt: excerptFor(doc.description, doc.content),
            title: doc.title,
            url: doc.route,
          });
        }
        if (hits.length >= SEARCH_LIMIT) {
          return Promise.resolve(hits);
        }
      }
    }
    return Promise.resolve(hits);
  };
};
