import { highlight, sanitizeExcerpt, SEARCH_LIMIT } from "./types.ts";
import type { SearchFn } from "./types.ts";

interface PagefindResult {
  data: () => Promise<{
    url: string;
    excerpt: string;
    meta?: { title?: string };
  }>;
}

/** One Pagefind instance: a page language's index, plus any merged into it. */
interface PagefindInstance {
  mergeIndex: (
    url: string,
    options: { baseUrl: string; language: string }
  ) => Promise<void>;
  search: (query: string) => Promise<{ results: PagefindResult[] }>;
}

interface PagefindModule {
  createInstance: (options: {
    basePath: string;
    baseUrl: string;
  }) => PagefindInstance;
}

/** `pagefind-entry.json`: the bundle's index for each language. */
interface PagefindEntry {
  languages: Record<string, { page_count: number }>;
}

// Pagefind names each page after its built file (`quickstart/index.html`), so
// its URLs end in a slash. Blume serves pages without one (`trailingSlash:
// "never"`): hosts redirect the slashed URL, and `blume preview` 404s it.
const TRAILING_SLASH = /(?<=.)\/(?=[#?]|$)/u;

/**
 * The language whose index Pagefind loads for a page, picked the way its
 * `findIndex` does: the page's own, else its base language (`pt` for
 * `pt-br`), else the language with the most pages (a locale with no
 * translated pages has no index of its own).
 */
const loadedLanguage = (
  languages: PagefindEntry["languages"],
  language: string
): string | undefined => {
  const [base = language] = language.split("-");
  if (languages[language]) {
    return language;
  }
  if (languages[base]) {
    return base;
  }
  return Object.entries(languages).toSorted(
    ([, a], [, b]) => b.page_count - a.page_count
  )[0]?.[0];
};

/**
 * Pagefind: load the index emitted into the built site and query it. The bundle
 * lives in the output (not `node_modules`), so it is imported at runtime by URL
 * — which is why this only works in the production build, not `dev`.
 *
 * Pagefind keeps an index per language and searches the one for the page's
 * `<html lang>`, which Blume sets to the locale the dialog scopes to. A
 * search scoped to a locale is that index alone; a search across every
 * language (no `locale`) merges every other language's index into it.
 */
export const createSearch = async (opts: {
  url: string;
}): Promise<SearchFn> => {
  // The pagefind bundle lives in the built site (not node_modules) and is
  // resolved at runtime by URL — it can't be a static, code-splittable path.
  // SAFETY: the URL points at the `pagefind.js` module our own build emitted,
  // whose export contract (`createInstance()`) is fixed by pagefind.
  // oxlint-disable-next-line react-doctor/no-dynamic-import-path
  const pagefind = (await import(
    /* @vite-ignore */
    opts.url
  )) as PagefindModule;
  // The bundle's folder, which holds the entry file and every language's index.
  const bundle = new URL("./", new URL(opts.url, document.baseURI));
  // `baseUrl` "/" keeps result URLs base-less routes, like every other
  // provider's: by default Pagefind prefixes the folder the bundle is served
  // under, and the dialog adds the deployment base itself.
  const create = (): PagefindInstance =>
    pagefind.createInstance({ basePath: bundle.pathname, baseUrl: "/" });

  // Every language's index: the page's own, and every other one merged in.
  const everyLanguage = async (language: string): Promise<PagefindInstance> => {
    const instance = create();
    const response = await fetch(new URL("pagefind-entry.json", bundle));
    // SAFETY: the entry file is the one Pagefind wrote into this bundle.
    const { languages } = (await response.json()) as PagefindEntry;
    const own = loadedLanguage(languages, language);
    // Pagefind skips a merge whose path its own `basePath` starts with, as
    // the same index twice, so the bundle is merged by its full URL.
    await Promise.all(
      Object.keys(languages)
        .filter((code) => code !== own)
        .map((code) =>
          instance.mergeIndex(bundle.href, { baseUrl: "/", language: code })
        )
    );
    return instance;
  };

  // Pagefind reads the page's language once, when an instance is created. A
  // client-side language switch changes the page's language without a
  // reload, so each language gets its own instance, created on its first
  // search: after the switch, search moves to the new page's index. The
  // every-language instance is one for the whole page load.
  const instances = new Map<string, Promise<PagefindInstance>>();
  const cached = (
    key: string,
    load: () => Promise<PagefindInstance>
  ): Promise<PagefindInstance> => {
    const existing = instances.get(key);
    if (existing) {
      return existing;
    }
    const loading = (async () => {
      try {
        return await load();
      } catch (error) {
        // A failed load (the entry file's fetch, say) is forgotten, so the
        // next search retries it.
        instances.delete(key);
        throw error;
      }
    })();
    instances.set(key, loading);
    return loading;
  };

  // Pagefind builds its own marked-up excerpt; we keep its `<mark>` highlights
  // (dropping any other markup — the excerpt is rendered via innerHTML) and
  // only highlight the title ourselves. It carries no section/breadcrumb data,
  // so pills stay hidden and the preview pane falls back to the excerpt.
  return async (query, options) => {
    // Lowercased like Pagefind's own reading, which names the entry's indexes.
    const language = document.documentElement.lang.toLowerCase() || "unknown";
    const instance = await (options?.locale
      ? cached(language, () => Promise.resolve(create()))
      : cached("*", () => everyLanguage(language)));
    const response = await instance.search(query);
    const docs = await Promise.all(
      response.results.slice(0, SEARCH_LIMIT).map((result) => result.data())
    );
    const hits = docs.map((doc) => ({
      excerpt: sanitizeExcerpt(doc.excerpt),
      title: highlight(doc.meta?.title ?? doc.url, query),
      url: doc.url.replace(TRAILING_SLASH, ""),
    }));
    return { hits, sections: [] };
  };
};
