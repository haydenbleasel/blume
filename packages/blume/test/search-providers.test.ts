import { describe, expect, it } from "bun:test";

import {
  mixedbreadSearchEndpointTemplate,
  runtimeDependencies,
  searchClientTemplate,
} from "../src/astro/templates.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { serverFeatures } from "../src/core/server-features.ts";
import type { SearchDocument } from "../src/search/documents.ts";
import { toSearchRecords } from "../src/search/documents.ts";
import { searchProviderMeta } from "../src/search/providers.ts";
import { syncSearchProvider } from "../src/search/sync/index.ts";

const parse = (search: Record<string, unknown>) =>
  blumeConfigSchema.parse({ search });

/** A minimal project with no pages — enough to drive the sync dispatcher. */
const emptyProject = (search: Record<string, unknown>): BlumeProject =>
  ({
    config: parse(search),
    graph: { pages: [] },
    manifest: { routes: [] },
  }) as unknown as BlumeProject;

/** A reporter that records every message it receives, by channel. */
const reporter = () => {
  const calls: { start: string[]; success: string[]; warn: string[] } = {
    start: [],
    success: [],
    warn: [],
  };
  return {
    calls,
    start: (m: string) => calls.start.push(m),
    success: (m: string) => calls.success.push(m),
    warn: (m: string) => calls.warn.push(m),
  };
};

describe("search config schema", () => {
  it("defaults to the orama provider", () => {
    expect(blumeConfigSchema.parse({}).search.provider).toBe("orama");
  });

  it("accepts the keyless providers without extra config", () => {
    expect(parse({ provider: "flexsearch" }).search.provider).toBe(
      "flexsearch"
    );
    expect(parse({ provider: "pagefind" }).search.provider).toBe("pagefind");
  });

  it("requires the matching config block for a hosted provider", () => {
    const result = blumeConfigSchema.safeParse({
      search: { provider: "algolia" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toStrictEqual(["search", "algolia"]);
    }
  });

  it("accepts a fully configured hosted provider", () => {
    const config = parse({
      algolia: { appId: "APP", indexName: "docs", searchApiKey: "key" },
      provider: "algolia",
    });
    expect(config.search.algolia?.appId).toBe("APP");
  });
});

describe("searchProviderMeta", () => {
  it("marks mixedbread as server-only", () => {
    expect(searchProviderMeta("mixedbread").requiresServer).toBe(true);
    expect(searchProviderMeta("mixedbread").kind).toBe("server");
  });

  it("marks orama as a keyless static provider", () => {
    expect(searchProviderMeta("orama").kind).toBe("static");
    expect(searchProviderMeta("orama").requiresServer).toBe(false);
  });

  it("only the hosted providers sync at build time", () => {
    expect(searchProviderMeta("algolia").syncs).toBe(true);
    expect(searchProviderMeta("typesense").syncs).toBe(true);
    expect(searchProviderMeta("orama-cloud").syncs).toBe(true);
    expect(searchProviderMeta("mixedbread").syncs).toBe(false);
    expect(searchProviderMeta("flexsearch").syncs).toBe(false);
  });
});

describe("runtimeDependencies", () => {
  it("declares only the configured provider's SDK", () => {
    const config = parse({
      provider: "typesense",
      typesense: { collection: "docs", host: "h", searchApiKey: "k" },
    });
    const deps = runtimeDependencies({ config, needsReact: false });
    expect(deps).toContain("typesense");
    expect(deps).not.toContain("algoliasearch");
    expect(deps).not.toContain("@mixedbread/sdk");
  });

  it("adds no search SDK for pagefind", () => {
    const config = parse({ provider: "pagefind" });
    const deps = runtimeDependencies({ config, needsReact: false });
    expect(deps).toStrictEqual(["@astrojs/mdx"]);
  });
});

describe("toSearchRecords", () => {
  it("maps documents to the hosted record shape with the first tag", () => {
    const docs: SearchDocument[] = [
      {
        breadcrumb: ["Guides"],
        content: "body",
        description: "desc",
        locale: "en",
        route: "/a",
        section: "Guides",
        tags: ["guides", "intro"],
        title: "A",
      },
    ];
    expect(toSearchRecords(docs)).toStrictEqual([
      {
        _id: "/a",
        content: "body",
        description: "desc",
        locale: "en",
        tag: "guides",
        title: "A",
        url: "/a",
      },
    ]);
  });

  it("omits the tag when there are none", () => {
    const [record] = toSearchRecords([
      {
        breadcrumb: [],
        content: "",
        description: "",
        locale: "",
        route: "/x",
        section: "Docs",
        title: "X",
      },
    ]);
    expect(record?.tag).toBeUndefined();
  });
});

describe("searchClientTemplate", () => {
  it("bakes public credentials into the hosted client", () => {
    const config = parse({
      algolia: { appId: "APP", indexName: "docs", searchApiKey: "pub" },
      provider: "algolia",
    });
    const client = searchClientTemplate(config);
    expect(client).toContain("search/algolia.ts");
    expect(client).toContain('"appId":"APP"');
    expect(client).toContain('"searchApiKey":"pub"');
  });

  it("loads the static index for both client-side providers", () => {
    for (const provider of ["orama", "flexsearch"]) {
      const client = searchClientTemplate(parse({ provider }));
      expect(client).toContain(`search/${provider}.ts`);
      expect(client).toContain("blume-search.json");
    }
  });

  it("points orama-cloud at its endpoint and key", () => {
    const client = searchClientTemplate(
      parse({
        oramaCloud: { apiKey: "pub", endpoint: "https://x.orama.run" },
        provider: "orama-cloud",
      })
    );
    expect(client).toContain("search/orama-cloud.ts");
    expect(client).toContain('"endpoint":"https://x.orama.run"');
    // The sync-only index id never reaches the client.
    expect(client).not.toContain("indexId");
  });

  it("passes the typesense host and collection", () => {
    const client = searchClientTemplate(
      parse({
        provider: "typesense",
        typesense: { collection: "docs", host: "h.ts.net", searchApiKey: "k" },
      })
    );
    expect(client).toContain("search/typesense.ts");
    expect(client).toContain('"collection":"docs"');
  });

  it("targets the server endpoint for mixedbread", () => {
    const client = searchClientTemplate(
      parse({ mixedbread: { storeId: "s" }, provider: "mixedbread" })
    );
    expect(client).toContain("search/endpoint.ts");
    expect(client).toContain("api/search");
  });

  it("loads the pagefind bundle by URL", () => {
    const client = searchClientTemplate(parse({ provider: "pagefind" }));
    expect(client).toContain("search/pagefind.ts");
    expect(client).toContain("pagefind/pagefind.js");
  });

  it("falls back to a no-op client when search is disabled", () => {
    const client = searchClientTemplate(parse({ provider: "none" }));
    expect(client).toContain("Promise.resolve({ hits: [], sections: [] })");
  });
});

describe("mixedbreadSearchEndpointTemplate", () => {
  it("reads the secret from the environment and bakes the store id", () => {
    const endpoint = mixedbreadSearchEndpointTemplate("store-123");
    expect(endpoint).toContain("process.env.MIXEDBREAD_API_KEY");
    expect(endpoint).toContain('"store-123"');
    expect(endpoint).toContain("export const prerender = false;");
  });
});

describe("syncSearchProvider", () => {
  it("is a no-op for providers that don't sync", async () => {
    const log = reporter();
    await syncSearchProvider(emptyProject({ provider: "orama" }), log);
    expect(log.calls.start).toHaveLength(0);
    expect(log.calls.warn).toHaveLength(0);
  });

  // Every hosted provider's sync reads its admin key from the environment, and
  // warns-and-skips (rather than failing the build) when it isn't set.
  const hosted = [
    {
      env: "ALGOLIA_ADMIN_API_KEY",
      search: {
        algolia: { appId: "a", indexName: "i", searchApiKey: "k" },
        provider: "algolia",
      },
    },
    {
      env: "ORAMA_PRIVATE_API_KEY",
      search: {
        oramaCloud: { apiKey: "p", endpoint: "e", indexId: "id" },
        provider: "orama-cloud",
      },
    },
    {
      env: "TYPESENSE_ADMIN_API_KEY",
      search: {
        provider: "typesense",
        typesense: { collection: "c", host: "h", searchApiKey: "k" },
      },
    },
  ];

  for (const { env, search } of hosted) {
    it(`warns and skips ${search.provider} when ${env} is missing`, async () => {
      Reflect.deleteProperty(process.env, env);
      const log = reporter();
      await syncSearchProvider(emptyProject(search), log);
      expect(log.calls.start).toHaveLength(1);
      expect(log.calls.success).toHaveLength(0);
      expect(log.calls.warn[0]).toContain(`${env} is not set`);
    });
  }
});

describe("serverFeatures", () => {
  it("requires server output for mixedbread search", () => {
    const config = parse({
      mixedbread: { storeId: "store" },
      provider: "mixedbread",
    });
    expect(serverFeatures(config)).toContain("Search (mixedbread)");
  });

  it("does not gate the static providers", () => {
    expect(serverFeatures(parse({ provider: "orama" }))).toStrictEqual([]);
  });
});
