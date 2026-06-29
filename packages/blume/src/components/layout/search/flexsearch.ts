import { Document } from "flexsearch";

import { buildResult, RESULT_POOL } from "./types.ts";
import type { IndexedDocument, SearchFn } from "./types.ts";

/**
 * FlexSearch: reuse the same static `blume-search.json` Orama ships, but build
 * a FlexSearch document index in the browser. Keyless; works in dev and build.
 * Matched routes are resolved back to their full documents (so we never depend
 * on `enrich` typing) and shaped by the shared `buildResult` helper.
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
  return (query, options) => {
    const groups = index.search(query, { limit: RESULT_POOL });
    const matched: IndexedDocument[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const id of group.result) {
        const route = String(id);
        if (seen.has(route)) {
          continue;
        }
        seen.add(route);
        const doc = byRoute.get(route);
        // Filter to the active locale (when one is requested) before shaping,
        // so section counts and results stay within the language.
        if (doc && (!options?.locale || doc.locale === options.locale)) {
          matched.push(doc);
        }
      }
    }
    return Promise.resolve(buildResult(matched, query, options?.section));
  };
};
