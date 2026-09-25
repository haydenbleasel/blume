import { describe, expect, it } from "bun:test";

import { astroConfigTemplate } from "../src/astro/templates.ts";
import type { BlumeConfig } from "../src/core/config-input.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  algolia,
  flexsearch,
  mixedbread,
  orama,
  oramaCloud,
  pagefind,
  typesense,
} from "../src/search/adapters/index.ts";

/** The generated config's `optimizeDeps.include` list for a `search` setting. */
const includeFor = (search?: BlumeConfig["search"]): string[] => {
  const out = astroConfigTemplate({
    askPath: "/p/.blume/src/generated/Ask.astro",
    config: blumeConfigSchema.parse({ search }),
    contentRoutes: [],
    context: {
      componentsFile: null,
      configFile: null,
      contentRoot: "/p/docs",
      outDir: "/p/.blume",
      pagesRoot: null,
      root: "/p",
      themeFile: null,
    },
    examplesPath: "/p/.blume/src/generated/examples.ts",
    examplesThemePath: "/p/.blume/src/generated/examples.css",
    features: { epub: false, mermaid: false },
    featuresPath: "/p/.blume/src/generated/features.ts",
    needsReact: false,
    pages: [],
    searchClientPath: "/p/.blume/src/generated/search-client.ts",
    themePath: "/p/.blume/src/generated/app.css",
  });
  const match = /include: (?<list>\[[^\]]*\])/u.exec(out);
  // SAFETY: the template serializes the list with JSON.stringify.
  return JSON.parse(match?.groups?.list ?? "null") as string[];
};

describe("the dev dep optimizer's search client include", () => {
  it("pre-bundles the default Orama client's library", () => {
    // The search dialog lazy-imports its client on first open, after the
    // optimizer's startup run: without the include, the first search of a
    // fresh `blume dev` session re-optimized and reloaded the page.
    expect(includeFor()).toEqual(["blume > @orama/orama"]);
    expect(includeFor(orama())).toEqual(["blume > @orama/orama"]);
  });

  it("pre-bundles exactly the library each browser-side adapter imports", () => {
    expect(includeFor(flexsearch())).toEqual(["blume > flexsearch"]);
    // The Algolia client imports the lite entry, not the package root.
    expect(
      includeFor(algolia({ apiKey: "K", appId: "A", indexName: "I" }))
    ).toEqual(["blume > algoliasearch/lite"]);
    expect(
      includeFor(oramaCloud({ apiKey: "K", endpoint: "https://e" }))
    ).toEqual(["blume > @oramacloud/client"]);
    expect(
      includeFor(typesense({ apiKey: "K", collection: "c", host: "h" }))
    ).toEqual(["blume > typesense"]);
  });

  it("adds nothing for adapters that load no npm library in the browser", () => {
    // Pagefind loads its script from the build output, Mixedbread queries
    // through the server route, and `search: false` has no client at all.
    expect(includeFor(pagefind())).toEqual([]);
    expect(includeFor(mixedbread({ storeId: "s" }))).toEqual([]);
    expect(includeFor(false)).toEqual([]);
  });
});
