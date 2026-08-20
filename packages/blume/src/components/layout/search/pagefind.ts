import { highlight, sanitizeExcerpt, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn } from "./types.ts";

interface PagefindResult {
  data: () => Promise<{
    url: string;
    excerpt: string;
    meta?: { title?: string };
  }>;
}

interface PagefindModule {
  search: (query: string) => Promise<{ results: PagefindResult[] }>;
}

/**
 * Pagefind: load the index emitted into the built site and query it. The bundle
 * lives in the output (not `node_modules`), so it is imported at runtime by URL
 * — which is why this only works in the production build, not `dev`.
 */
export const createSearch = async (opts: {
  url: string;
}): Promise<SearchFn> => {
  // The pagefind bundle lives in the built site (not node_modules) and is
  // resolved at runtime by URL — it can't be a static, code-splittable path.
  // SAFETY: the URL points at the `pagefind.js` module our own build emitted,
  // whose export contract (`search()`) is fixed by pagefind.
  // oxlint-disable-next-line react-doctor/no-dynamic-import-path
  const pagefind = (await import(
    /* @vite-ignore */
    opts.url
  )) as PagefindModule;
  // Pagefind builds its own marked-up excerpt; we keep its `<mark>` highlights
  // (dropping any other markup — the excerpt is rendered via innerHTML) and
  // only highlight the title ourselves. It carries no section/breadcrumb data,
  // so pills stay hidden and the preview pane falls back to the excerpt.
  return async (query) => {
    const response = await pagefind.search(query);
    const docs = await Promise.all(
      response.results.slice(0, SEARCH_LIMIT).map((result) => result.data())
    );
    const hits = docs.map((doc) => ({
      excerpt: sanitizeExcerpt(doc.excerpt),
      title: highlight(doc.meta?.title ?? doc.url, query),
      url: doc.url,
    }));
    return { hits, sections: [] };
  };
};
