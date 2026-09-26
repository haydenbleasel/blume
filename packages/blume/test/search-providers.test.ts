import { describe, expect, it } from "bun:test";

import {
  mixedbreadSearchEndpointTemplate,
  runtimeDependencies,
  searchClientTemplate,
} from "../src/astro/templates.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import type { BlumeConfigInput, ResolvedConfig } from "../src/core/schema.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { serverFeatures } from "../src/core/server-features.ts";
import type { ContentSource } from "../src/core/sources/types.ts";
import type { NavNode, PageRecord } from "../src/core/types.ts";
import {
  algolia,
  flexsearch,
  mixedbread,
  orama,
  oramaCloud,
  pagefind,
  typesense,
} from "../src/search/adapters/index.ts";
import { NONE_SEARCH_ADAPTER } from "../src/search/adapters/registry.ts";
import type { AnySearchAdapter } from "../src/search/adapters/registry.ts";
import type { SearchDocument } from "../src/search/documents.ts";
import { toSearchRecords } from "../src/search/documents.ts";
import { syncSearchProvider } from "../src/search/sync/index.ts";
import { syncOramaCloud } from "../src/search/sync/orama-cloud.ts";

type SearchInput = BlumeConfigInput["search"];

/**
 * The slice of {@link BlumeProject} these tests exercise. Each leaf uses the
 * real domain type, so the full project type stays assignable to the fixture
 * type and a single asserted widening suffices.
 */
interface ProjectFixture {
  config: ResolvedConfig;
  graph: {
    navigationByLocale?: Record<string, { sidebar: NavNode[] }>;
    pages: PageRecord[];
  };
  manifest: {
    routes: {
      id: string;
      indexable: boolean;
      locale: string;
      path: string;
      title: string;
    }[];
  };
  /** No API reference: the reference serializers decline. */
  sources: ContentSource[];
}

const parse = (search: SearchInput) => blumeConfigSchema.parse({ search });

/** A minimal project with no pages — enough to drive the sync dispatcher. */
const emptyProject = (search: SearchInput): BlumeProject => {
  const fixture: ProjectFixture = {
    config: parse(search),
    graph: { pages: [] },
    manifest: { routes: [] },
    sources: [],
  };
  // SAFETY: the sync dispatcher reads only config, graph.pages,
  // manifest.routes, and sources from the project; the remaining BlumeProject
  // fields are never touched by these tests.
  return fixture as BlumeProject;
};

/** The channels a reporter fixture records, one message list per channel. */
interface ReporterCalls {
  start: string[];
  success: string[];
  warn: string[];
}

/** A reporter that records every message it receives, by channel. */
const reporter = () => {
  const calls: ReporterCalls = {
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

const ALGOLIA = { apiKey: "pub", appId: "APP", indexName: "docs" };
const ORAMA_CLOUD = {
  apiKey: "pub",
  endpoint: "https://x.orama.run",
  indexId: "idx",
};
const TYPESENSE = { apiKey: "k", collection: "docs", host: "h.ts.net" };

/**
 * Every public adapter with the client module its generated `search-client.ts`
 * must import and the SDK its `.blume/package.json` must declare. The table
 * drives the per-adapter template tests: each adapter references exactly its
 * own module and dependency, and none of the others'.
 */
const ADAPTERS: {
  adapter: AnySearchAdapter;
  deps: string[];
  module: string;
}[] = [
  { adapter: algolia(ALGOLIA), deps: ["algoliasearch"], module: "algolia" },
  { adapter: flexsearch(), deps: ["flexsearch"], module: "flexsearch" },
  {
    adapter: mixedbread({ storeId: "s" }),
    deps: ["@mixedbread/sdk"],
    module: "endpoint",
  },
  { adapter: orama(), deps: ["@orama/orama"], module: "orama" },
  {
    adapter: oramaCloud(ORAMA_CLOUD),
    deps: ["@oramacloud/client"],
    module: "orama-cloud",
  },
  { adapter: pagefind(), deps: [], module: "pagefind" },
  { adapter: typesense(TYPESENSE), deps: ["typesense"], module: "typesense" },
];

const ALL_MODULES = ADAPTERS.map((entry) => entry.module);
const ALL_DEPS = ADAPTERS.flatMap((entry) => entry.deps);

describe("search adapter factories", () => {
  it("return plain descriptors that survive a JSON round-trip", () => {
    for (const { adapter } of ADAPTERS) {
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round-trip is the claim: the templates inline descriptors with JSON.stringify, which drops what structuredClone keeps
      expect(JSON.parse(JSON.stringify(adapter))).toStrictEqual(adapter);
    }
  });

  it("declare their mode, runtime dependency, and required secrets", () => {
    expect(orama()).toMatchObject({ mode: "static", requiredSecrets: [] });
    expect(flexsearch().mode).toBe("static");
    expect(pagefind()).toMatchObject({ mode: "pagefind", runtimeDeps: [] });
    expect(algolia(ALGOLIA).mode).toBe("hosted");
    expect(oramaCloud(ORAMA_CLOUD).mode).toBe("hosted");
    expect(typesense(TYPESENSE).mode).toBe("hosted");
    expect(mixedbread({ storeId: "s" })).toMatchObject({
      mode: "server",
      requiredSecrets: ["MIXEDBREAD_API_KEY"],
    });
  });

  it("keep the options verbatim, including keys Blume doesn't name", () => {
    const adapter = algolia({ ...ALGOLIA, hitsPerPage: 5 });
    expect(adapter.options).toStrictEqual({ ...ALGOLIA, hitsPerPage: 5 });
  });
});

describe("search config schema", () => {
  it("defaults to orama with no config", () => {
    expect(blumeConfigSchema.parse({}).search.provider).toStrictEqual(orama());
  });

  it("defaults to excluding code blocks from the search index", () => {
    expect(blumeConfigSchema.parse({}).search.indexing).toMatchObject({
      includeCodeBlocks: false,
      includeHiddenPages: false,
    });
  });

  it("accepts nested JSON in a passthrough option", () => {
    const result = blumeConfigSchema.safeParse({
      search: algolia({
        ...ALGOLIA,
        facets: { tags: ["a", "b"], weights: [1, null] },
      }),
    });
    expect(result.success).toBe(true);
  });

  it("rejects passthrough values JSON would drop or choke on, with a path", () => {
    const cases = [
      ["bigint", 10n],
      ["fn", () => 1],
      ["nan", Number.NaN],
      ["undefined", undefined],
    ] as const;
    for (const [name, value] of cases) {
      const result = blumeConfigSchema.safeParse({
        search: { ...algolia(ALGOLIA), options: { ...ALGOLIA, probe: value } },
      });
      expect(result.success, `${name} should be rejected`).toBe(false);
      // The shorthand normalizes to the object form, hence `provider`.
      expect(result.error?.issues[0]?.path).toEqual([
        "search",
        "provider",
        "options",
        "probe",
      ]);
    }
    expect(
      blumeConfigSchema.safeParse({
        search: { ...orama(), options: { probe: () => 1 } },
      }).success
    ).toBe(false);
  });

  it("rejects unknown keys on the keyless adapters, with a path", () => {
    // The static and Pagefind clients never read `options`, so an unknown key
    // would otherwise pass validation and do nothing.
    for (const adapter of [orama(), flexsearch(), pagefind()]) {
      // The options type rejects the key, so the descriptor is spread instead.
      const result = blumeConfigSchema.safeParse({
        search: { ...adapter, options: { probe: 1 } },
      });
      expect(result.success, `${adapter.kind} should reject`).toBe(false);
      // Zod anchors an unrecognized-keys issue at the object and lists the
      // offending keys on it, rather than one issue per key.
      expect(result.error?.issues[0]).toMatchObject({
        code: "unrecognized_keys",
        keys: ["probe"],
        path: ["search", "provider", "options"],
      });
    }
  });

  it("still accepts the keyless adapters with no options", () => {
    for (const adapter of [orama(), flexsearch(), pagefind()]) {
      expect(parse(adapter).search.provider).toStrictEqual(adapter);
    }
  });

  it("accepts an adapter directly as shorthand for the object form", () => {
    const shorthand = parse(algolia(ALGOLIA)).search;
    const object = parse({ provider: algolia(ALGOLIA) }).search;
    expect(shorthand).toStrictEqual(object);
    expect(shorthand.provider).toStrictEqual(algolia(ALGOLIA));
    expect(shorthand.popular).toStrictEqual([]);
  });

  it("keeps popular links and indexing beside the adapter in the object form", () => {
    const config = parse({
      indexing: { includeCodeBlocks: true },
      popular: [{ href: "/docs", label: "Docs" }],
      provider: pagefind(),
    });
    expect(config.search.provider).toStrictEqual(pagefind());
    expect(config.search.indexing.includeCodeBlocks).toBe(true);
    expect(config.search.popular).toHaveLength(1);
  });

  it("resolves false to the none adapter at either level", () => {
    expect(parse(false).search.provider).toStrictEqual(NONE_SEARCH_ADAPTER);
    // The object form still carries indexing, which the MCP index reads.
    const config = parse({
      indexing: { includeHiddenPages: true },
      provider: false,
    });
    expect(config.search.provider.mode).toBe("none");
    expect(config.search.indexing.includeHiddenPages).toBe(true);
  });

  it("accepts a descriptor that went through JSON", () => {
    for (const { adapter } of ADAPTERS) {
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- a config that inlined JSON.stringify(adapter) is what the schema must accept
      const config = parse(JSON.parse(JSON.stringify(adapter)));
      expect(config.search.provider).toStrictEqual(adapter);
    }
  });

  it("re-derives the metadata from the factory", () => {
    // A descriptor serialized by an older Blume (or edited by hand) resolves
    // to the metadata this version ships, not whatever it carried.
    const stale = {
      ...algolia(ALGOLIA),
      requiredSecrets: ["X"],
      runtimeDeps: [],
    };
    expect(parse(stale).search.provider).toStrictEqual(algolia(ALGOLIA));
  });

  it("validates an adapter's options and points at the missing one", () => {
    const result = blumeConfigSchema.safeParse({
      search: { ...algolia(ALGOLIA), options: { appId: "APP" } },
    });
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("search.provider.options.apiKey");
    expect(paths).toContain("search.provider.options.indexName");
  });

  it("rejects an unknown adapter kind", () => {
    const result = blumeConfigSchema.safeParse({
      search: { ...orama(), kind: "elastic" },
    });
    expect(result.success).toBe(false);
  });

  it("reports the removed 1.x provider string as a diagnostic, not a crash", () => {
    // A leftover `search: { provider: "algolia" }` still parses as the object
    // form and fails inside `provider`; a bare string or null reaches the
    // shorthand lift, which must refuse it before the `in` check runs.
    for (const search of ["orama", null, true]) {
      const result = blumeConfigSchema.safeParse({ search });
      expect(result.success).toBe(false);
      const messages = result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
      expect(messages[0]).toContain('"blume/search"');
    }
  });

  it("names the adapter for a 1.x provider name and credential block", () => {
    // The 1.x object form: a provider name beside its credentials block.
    const result = blumeConfigSchema.safeParse({
      search: {
        algolia: { appId: "APP", indexName: "docs", searchApiKey: "KEY" },
        provider: "algolia",
      },
    });
    const messages = result.success
      ? []
      : result.error.issues.map((issue) => issue.message);
    expect(messages).toContainEqual(
      expect.stringContaining("not a provider name")
    );
    expect(messages).toContainEqual(
      expect.stringContaining("search: algolia({ appId, indexName, apiKey })")
    );
  });

  it("names each 1.x credential block's adapter", () => {
    for (const [key, adapter] of [
      ["mixedbread", "mixedbread({ storeId })"],
      ["oramaCloud", "oramaCloud({ endpoint, apiKey, indexId })"],
      ["typesense", "typesense({ host, collection, apiKey })"],
    ] as const) {
      const result = blumeConfigSchema.safeParse({ search: { [key]: {} } });
      const messages = result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
      expect(messages.join(" ")).toContain(adapter);
    }
  });
});

describe("runtimeDependencies", () => {
  for (const { adapter, deps } of ADAPTERS) {
    it(`declares only the ${adapter.kind} SDK`, () => {
      const declared = runtimeDependencies({
        config: parse(adapter),
        needsReact: false,
      });
      for (const dep of deps) {
        expect(declared).toContain(dep);
      }
      for (const dep of ALL_DEPS.filter((d) => !deps.includes(d))) {
        expect(declared).not.toContain(dep);
      }
    });
  }

  it("declares no search SDK when search is disabled", () => {
    const declared = runtimeDependencies({
      config: parse(false),
      needsReact: false,
    });
    expect(declared).toStrictEqual(["@astrojs/mdx"]);
  });
});

describe("searchClientTemplate", () => {
  for (const { adapter, module } of ADAPTERS) {
    it(`imports only the ${adapter.kind} client module`, () => {
      const client = searchClientTemplate(parse(adapter));
      expect(client).toContain(`search/${module}.ts`);
      for (const other of ALL_MODULES.filter((m) => m !== module)) {
        expect(client).not.toContain(`search/${other}.ts`);
      }
    });
  }

  it("inlines a hosted adapter's options verbatim as a literal", () => {
    const client = searchClientTemplate(
      parse(algolia({ ...ALGOLIA, hitsPerPage: 5 }))
    );
    expect(client).toContain(
      `create(${JSON.stringify({ ...ALGOLIA, hitsPerPage: 5 })})`
    );
  });

  it("loads the static index for both client-side adapters", () => {
    for (const adapter of [orama(), flexsearch()]) {
      const client = searchClientTemplate(parse(adapter));
      expect(client).toContain("blume-search.json");
    }
  });

  it("bakes i18n.defaultLocale into the orama client for tokenizer selection", () => {
    const config = blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "ja",
        locales: [{ code: "ja", label: "日本語" }],
      },
      search: orama(),
    });
    expect(searchClientTemplate(config)).toContain(
      'create({ indexUrl, locale: "ja" })'
    );
  });

  it("omits the locale without i18n, and always for flexsearch", () => {
    expect(searchClientTemplate(parse(orama()))).toContain(
      "create({ indexUrl })"
    );
    // FlexSearch has no tokenizer hook, so its client never takes a locale.
    const config = blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "ja",
        locales: [{ code: "ja", label: "日本語" }],
      },
      search: flexsearch(),
    });
    expect(searchClientTemplate(config)).toContain("create({ indexUrl })");
  });

  it("points orama-cloud at its endpoint and key", () => {
    const client = searchClientTemplate(parse(oramaCloud(ORAMA_CLOUD)));
    expect(client).toContain('"endpoint":"https://x.orama.run"');
    expect(client).toContain('"apiKey":"pub"');
  });

  it("passes the typesense host and collection", () => {
    const client = searchClientTemplate(parse(typesense(TYPESENSE)));
    expect(client).toContain('"collection":"docs"');
    expect(client).toContain('"host":"h.ts.net"');
  });

  it("targets the server endpoint for mixedbread", () => {
    const client = searchClientTemplate(parse(mixedbread({ storeId: "s" })));
    expect(client).toContain("api/search");
    // The store id is the endpoint's business; the client never sees it.
    expect(client).not.toContain('"s"');
  });

  it("loads the pagefind bundle by URL", () => {
    expect(searchClientTemplate(parse(pagefind()))).toContain(
      "pagefind/pagefind.js"
    );
  });

  it("falls back to a no-op client when search is disabled", () => {
    const client = searchClientTemplate(parse(false));
    expect(client).toContain("Promise.resolve({ hits: [], sections: [] })");
    for (const module of ALL_MODULES) {
      expect(client).not.toContain(`search/${module}.ts`);
    }
  });
});

describe("mixedbreadSearchEndpointTemplate", () => {
  it("reads the secret from the environment and inlines the options", () => {
    const endpoint = mixedbreadSearchEndpointTemplate({
      storeId: "store-123",
    });
    expect(endpoint).toContain('import { getSecret } from "astro:env/server"');
    expect(endpoint).toContain('getSecret("MIXEDBREAD_API_KEY")');
    expect(endpoint).toContain('const OPTIONS = {"storeId":"store-123"};');
    expect(endpoint).toContain("export const prerender = false;");
  });

  it("reads the request body under a cap before parsing it", () => {
    const endpoint = mixedbreadSearchEndpointTemplate({ storeId: "store-123" });
    expect(endpoint).toContain(
      'import { readCappedText } from "blume/core/request-body.ts";'
    );
    expect(endpoint).toContain("await readCappedText(request, 16_384)");
    expect(endpoint).toContain("status: 413");
    expect(endpoint).not.toContain("request.json()");
  });
});

describe("serverFeatures", () => {
  it("requires server output only for a server adapter", () => {
    expect(serverFeatures(parse(mixedbread({ storeId: "s" })))).toStrictEqual([
      "Search (mixedbread)",
    ]);
    for (const adapter of [orama(), pagefind(), algolia(ALGOLIA)]) {
      expect(serverFeatures(parse(adapter))).toStrictEqual([]);
    }
  });
});

describe("toSearchRecords", () => {
  it("maps documents to the hosted record shape with the first tag", () => {
    const docs: SearchDocument[] = [
      {
        breadcrumb: ["Guides"],
        content: "body",
        contentType: "doc",
        description: "desc",
        locale: "en",
        route: "/a",
        section: "Guides",
        tags: ["guides", "intro"],
        title: "A",
        version: "",
      },
    ];
    expect(toSearchRecords(docs)).toStrictEqual([
      {
        _id: "/a",
        boost: 1,
        content: "body",
        description: "desc",
        locale: "en",
        tag: "guides",
        title: "A",
        url: "/a",
        version: "current",
      },
    ]);
  });

  it("carries a page's boost and keywords", () => {
    const [record] = toSearchRecords([
      {
        boost: 4,
        breadcrumb: [],
        content: "",
        contentType: "doc",
        description: "",
        keywords: ["setup"],
        locale: "en",
        route: "/x",
        section: "Docs",
        title: "X",
        version: "",
      },
    ]);
    expect(record).toMatchObject({ boost: 4, keywords: ["setup"] });
  });

  it("omits the tag when there are none", () => {
    const [record] = toSearchRecords([
      {
        breadcrumb: [],
        content: "",
        contentType: "doc",
        description: "",
        locale: "",
        route: "/x",
        section: "Docs",
        title: "X",
        version: "",
      },
    ]);
    expect(record?.tag).toBeUndefined();
  });
});

describe("syncSearchProvider", () => {
  it("is a no-op for adapters without a build-time sync", async () => {
    const logs = [orama(), pagefind(), mixedbread({ storeId: "s" })].map(
      (search) => ({ log: reporter(), search })
    );
    await Promise.all(
      logs.map(({ log, search }) =>
        syncSearchProvider(emptyProject(search), log)
      )
    );
    for (const { log } of logs) {
      expect(log.calls.start).toHaveLength(0);
      expect(log.calls.warn).toHaveLength(0);
    }
  });

  // Every hosted adapter's sync reads its admin key from the environment, and
  // warns-and-skips (rather than failing the build) when it isn't set.
  const hosted = [
    { env: "ALGOLIA_ADMIN_API_KEY", search: algolia(ALGOLIA) },
    { env: "ORAMA_PRIVATE_API_KEY", search: oramaCloud(ORAMA_CLOUD) },
    { env: "TYPESENSE_ADMIN_API_KEY", search: typesense(TYPESENSE) },
  ];

  for (const { env, search } of hosted) {
    it(`warns and skips ${search.kind} when ${env} is missing`, async () => {
      Reflect.deleteProperty(process.env, env);
      const log = reporter();
      await syncSearchProvider(emptyProject(search), log);
      expect(log.calls.start).toHaveLength(1);
      expect(log.calls.success).toHaveLength(0);
      expect(log.calls.warn[0]).toContain(`${env} is not set`);
    });
  }

  it("throws when the orama-cloud index id is absent", async () => {
    // `indexId` is optional on the adapter (the browser client doesn't need
    // it), so the sync is what reports its absence.
    await expect(syncOramaCloud([], {})).rejects.toThrow("indexId");
  });
});
