import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { syncSearchProvider } from "../src/search/sync/index.ts";

/**
 * Runtime coverage for the per-provider client loaders and the hosted sync
 * uploads. The keyless providers (Orama, FlexSearch) run against their real
 * SDKs with a mocked `fetch`; every hosted SDK is replaced with `mock.module`
 * so we can assert the request/upload shape without a live service. Modules
 * under test are imported lazily inside each test so they bind to the mocks.
 *
 * Captured values live behind a `{ value?: T }` holder because a closure
 * assignment to a plain `let` doesn't widen its narrowed type at the read site.
 */

interface AlgoliaSearchParams {
  requests: { hitsPerPage: number; indexName: string; query: string }[];
}
interface SaveObjectsArgs {
  indexName: string;
  objects: Record<string, unknown>[];
}
interface TypesenseSearchParams {
  per_page: number;
  q: string;
  query_by: string;
}

// --- Mutable SDK behaviors the module mocks delegate to (set per test) ---
let algoliaSearch: (params: AlgoliaSearchParams) => Promise<unknown>;
let algoliaSave: (args: SaveObjectsArgs) => Promise<unknown>;
let oramaCloudSearch: (query: {
  limit: number;
  term: string;
}) => Promise<unknown>;
let cloudSnapshot: (data: unknown[]) => Promise<boolean>;
let cloudDeploy: () => Promise<boolean>;
let typesenseSearch: (params: TypesenseSearchParams) => Promise<unknown>;
let typesenseRetrieve: () => Promise<unknown>;
let typesenseCreate: (schema: unknown) => Promise<unknown>;
let typesenseImport: (
  docs: Record<string, unknown>[],
  options: { action: string }
) => Promise<unknown>;

// Turn an object factory into a `new`-able constructor — the SDKs are used as
// `new Client(...)` etc., and a constructor that returns an object yields it.
const asConstructor = <T>(make: () => T): new () => T =>
  function build(this: unknown) {
    return make();
  } as unknown as new () => T;

mock.module("algoliasearch/lite", () => ({
  liteClient: () => ({
    search: (params: AlgoliaSearchParams) => algoliaSearch(params),
  }),
}));
mock.module("algoliasearch", () => ({
  algoliasearch: () => ({
    saveObjects: (args: SaveObjectsArgs) => algoliaSave(args),
  }),
}));
mock.module("@oramacloud/client", () => ({
  CloudManager: asConstructor(() => ({
    index: () => ({
      deploy: () => cloudDeploy(),
      snapshot: (data: unknown[]) => cloudSnapshot(data),
    }),
  })),
  OramaClient: asConstructor(() => ({
    search: (query: { limit: number; term: string }) => oramaCloudSearch(query),
  })),
}));
mock.module("typesense", () => ({
  Client: asConstructor(() => ({
    collections: (_name?: string) => ({
      create: (schema: unknown) => typesenseCreate(schema),
      documents: () => ({
        import: (
          docs: Record<string, unknown>[],
          options: { action: string }
        ) => typesenseImport(docs, options),
        search: (params: TypesenseSearchParams) => typesenseSearch(params),
      }),
      retrieve: () => typesenseRetrieve(),
    }),
  })),
}));

const INDEX = [
  { content: "alpha body", description: "", route: "/a", title: "Alpha" },
  { content: "beta content", description: "", route: "/b", title: "Beta" },
];

let originalFetch: typeof globalThis.fetch;
const stubFetch = (impl: (...args: unknown[]) => Promise<Response>): void => {
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
};

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("client loaders", () => {
  it("orama builds an index from the JSON and ranks title matches", async () => {
    stubFetch(() => Promise.resolve(Response.json(INDEX)));
    const { createSearch } =
      await import("../src/components/layout/search/orama.ts");
    const search = await createSearch({ indexUrl: "/blume-search.json" });
    const { hits } = await search("alpha");
    expect(hits[0]?.url).toBe("/a");
    // The title carries `<mark>` highlight markup for the matched term.
    expect(hits[0]?.title).toContain("Alpha");
  });

  it("flexsearch indexes the JSON and finds the matching page", async () => {
    stubFetch(() => Promise.resolve(Response.json(INDEX)));
    const { createSearch } =
      await import("../src/components/layout/search/flexsearch.ts");
    const search = await createSearch({ indexUrl: "/blume-search.json" });
    const { hits } = await search("beta");
    expect(hits.map((hit) => hit.url)).toContain("/b");
  });

  it("endpoint posts the query and returns the server's hits", async () => {
    const captured: { body?: string; url?: unknown } = {};
    stubFetch((url: unknown, init: unknown) => {
      const request = init as { body?: string };
      captured.body = request?.body;
      captured.url = url;
      return Promise.resolve(
        Response.json([{ excerpt: "e", title: "X", url: "/x" }])
      );
    });
    const { createSearch } =
      await import("../src/components/layout/search/endpoint.ts");
    const { hits } = await createSearch({ api: "/api/search" })("hello");
    expect(captured.url).toBe("/api/search");
    expect(JSON.parse(captured.body ?? "{}").query).toBe("hello");
    expect(hits[0]?.url).toBe("/x");
  });

  it("algolia queries the configured index and maps hits", async () => {
    const captured: { value?: AlgoliaSearchParams } = {};
    algoliaSearch = (params) => {
      captured.value = params;
      return Promise.resolve({
        results: [
          { hits: [{ content: "c", description: "d", title: "A", url: "/a" }] },
        ],
      });
    };
    const { createSearch } =
      await import("../src/components/layout/search/algolia.ts");
    const search = createSearch({
      appId: "app",
      indexName: "docs",
      searchApiKey: "key",
    });
    const { hits } = await search("q");
    expect(captured.value?.requests[0]?.indexName).toBe("docs");
    expect(hits[0]?.url).toBe("/a");
    expect(hits[0]?.excerpt).toBe("d");
  });

  it("orama-cloud queries the hosted index", async () => {
    const captured: { value?: { limit: number; term: string } } = {};
    oramaCloudSearch = (query) => {
      captured.value = query;
      return Promise.resolve({
        hits: [
          {
            document: { content: "c", description: "d", title: "O", url: "/o" },
          },
        ],
      });
    };
    const { createSearch } =
      await import("../src/components/layout/search/orama-cloud.ts");
    const { hits } = await createSearch({ apiKey: "k", endpoint: "https://x" })(
      "q"
    );
    expect(captured.value?.term).toBe("q");
    expect(hits[0]?.url).toBe("/o");
  });

  it("typesense searches the collection by the indexed fields", async () => {
    const captured: { value?: TypesenseSearchParams } = {};
    typesenseSearch = (params) => {
      captured.value = params;
      return Promise.resolve({
        hits: [
          {
            document: { content: "c", description: "d", title: "T", url: "/t" },
          },
        ],
      });
    };
    const { createSearch } =
      await import("../src/components/layout/search/typesense.ts");
    const result = await createSearch({
      collection: "docs",
      host: "h",
      searchApiKey: "k",
    })("q");
    expect(captured.value?.q).toBe("q");
    expect(captured.value?.query_by).toContain("title");
    expect(result.hits[0]?.url).toBe("/t");
  });

  it("pagefind imports the built bundle and maps its results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-pagefind-"));
    const fixture = join(dir, "pagefind.mjs");
    await writeFile(
      fixture,
      'export const search = () => Promise.resolve({ results: [{ data: () => Promise.resolve({ excerpt: "pf", meta: { title: "PF" }, url: "/p" }) }] });\n'
    );
    const { createSearch } =
      await import("../src/components/layout/search/pagefind.ts");
    const search = await createSearch({ url: pathToFileURL(fixture).href });
    const { hits } = await search("q");
    expect(hits[0]?.url).toBe("/p");
    expect(hits[0]?.title).toBe("PF");
  });
});

describe("hosted sync uploads", () => {
  const records = [
    {
      _id: "/a",
      content: "c",
      description: "d",
      locale: "en",
      tag: "guides",
      title: "A",
      url: "/a",
    },
  ];

  it("algolia uploads objects keyed by objectID", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    const captured: { value?: SaveObjectsArgs } = {};
    algoliaSave = (args) => {
      captured.value = args;
      return Promise.resolve();
    };
    const { syncAlgolia } = await import("../src/search/sync/algolia.ts");
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(captured.value?.indexName).toBe("docs");
    expect(captured.value?.objects[0]?.objectID).toBe("/a");
  });

  it("orama-cloud snapshots the records and deploys", async () => {
    process.env.ORAMA_PRIVATE_API_KEY = "private";
    const captured: { snapshot?: unknown[]; deployed?: boolean } = {};
    cloudSnapshot = (data) => {
      captured.snapshot = data;
      return Promise.resolve(true);
    };
    cloudDeploy = () => {
      captured.deployed = true;
      return Promise.resolve(true);
    };
    const { syncOramaCloud } =
      await import("../src/search/sync/orama-cloud.ts");
    await syncOramaCloud(records, { indexId: "idx" });
    const first = captured.snapshot?.[0] as { id: string } | undefined;
    expect(first?.id).toBe("/a");
    expect(captured.deployed).toBe(true);
  });

  it("typesense creates the collection then upserts documents", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    const captured: {
      created?: boolean;
      docs?: Record<string, unknown>[];
      options?: { action: string };
    } = {};
    typesenseRetrieve = () => Promise.reject(new Error("not found"));
    typesenseCreate = (schema) => {
      captured.created = true;
      return Promise.resolve(schema);
    };
    typesenseImport = (docs, options) => {
      captured.docs = docs;
      captured.options = options;
      return Promise.resolve([]);
    };
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await syncTypesense(records, { collection: "docs", host: "h" });
    expect(captured.created).toBe(true);
    expect(captured.options?.action).toBe("upsert");
    expect(captured.docs?.[0]?.id).toBe("/a");
  });

  it("the dispatcher runs the provider sync and reports success", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    const captured: { value?: SaveObjectsArgs } = {};
    algoliaSave = (args) => {
      captured.value = args;
      return Promise.resolve();
    };
    const project = {
      config: blumeConfigSchema.parse({
        search: {
          algolia: { appId: "app", indexName: "docs", searchApiKey: "k" },
          provider: "algolia",
        },
      }),
      graph: { pages: [] },
      manifest: { routes: [] },
    } as unknown as BlumeProject;
    const messages: string[] = [];
    await syncSearchProvider(project, {
      start: (message) => messages.push(message),
      success: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    });
    expect(captured.value?.indexName).toBe("docs");
    expect(messages.some((message) => message.includes("Synced"))).toBe(true);
  });
});
