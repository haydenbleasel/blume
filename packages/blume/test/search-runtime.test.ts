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
  requests: {
    facetFilters?: string[];
    hitsPerPage: number;
    indexName: string;
    query: string;
  }[];
}
interface SaveObjectsArgs {
  indexName: string;
  objects: Record<string, unknown>[];
}
interface TypesenseSearchParams {
  filter_by?: string;
  per_page: number;
  q: string;
  query_by: string;
}
interface OramaCloudSearchParams {
  limit: number;
  term: string;
  where?: Record<string, string>;
}

// --- Mutable SDK behaviors the module mocks delegate to (set per test) ---
let algoliaSearch: (params: AlgoliaSearchParams) => Promise<unknown>;
let algoliaSave: (args: SaveObjectsArgs) => Promise<unknown>;
let oramaCloudSearch: (query: OramaCloudSearchParams) => Promise<unknown>;
let cloudSnapshot: (data: unknown[]) => Promise<boolean>;
let cloudDeploy: () => Promise<boolean>;
let typesenseSearch: (params: TypesenseSearchParams) => Promise<unknown>;
let typesenseRetrieve: () => Promise<unknown>;
let typesenseCreate: (schema: unknown) => Promise<unknown>;
let typesenseImport: (
  docs: Record<string, unknown>[],
  options: { action: string }
) => Promise<unknown>;
let typesenseDelete: () => Promise<unknown>;

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
    replaceAllObjects: (args: SaveObjectsArgs) => algoliaSave(args),
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
    search: (query: OramaCloudSearchParams) => oramaCloudSearch(query),
  })),
}));
// Hoisted out of the mock factory so its inner methods don't nest past the
// four-level depth limit (mock.module → constructor → collections → documents).
const typesenseDocuments = () => ({
  import: (docs: Record<string, unknown>[], options: { action: string }) =>
    typesenseImport(docs, options),
  search: (params: TypesenseSearchParams) => typesenseSearch(params),
});
mock.module("typesense", () => ({
  Client: asConstructor(() => ({
    collections: (_name?: string) => ({
      create: (schema: unknown) => typesenseCreate(schema),
      delete: () => typesenseDelete(),
      documents: typesenseDocuments,
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
          {
            hits: [
              // Current docs upload as version "current"; archived keep their
              // id; pre-versioning records have none.
              {
                content: "c",
                description: "d",
                title: "A",
                url: "/a",
                version: "current",
              },
              {
                content: "c2",
                description: "d2",
                title: "B",
                url: "/b",
                version: "v1.0",
              },
            ],
          },
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
    // No locale option means no facet filter — every language matches.
    expect(captured.value?.requests[0]?.facetFilters).toBeUndefined();
    expect(hits[0]?.url).toBe("/a");
    expect(hits[0]?.excerpt).toBe("d");
    // The record's version maps into the hit contract ("" = current) so the
    // cross-version badge works for hosted results too.
    expect(hits[0]?.version).toBe("");
    expect(hits[1]?.version).toBe("v1.0");

    await search("q", { locale: "fr" });
    expect(captured.value?.requests[0]?.facetFilters).toStrictEqual([
      "locale:fr",
    ]);
  });

  it("orama-cloud queries the hosted index", async () => {
    const captured: {
      value?: { limit: number; term: string; where?: Record<string, string> };
    } = {};
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
    const search = createSearch({ apiKey: "k", endpoint: "https://x" });
    const { hits } = await search("q");
    expect(captured.value?.term).toBe("q");
    // No locale option means no where clause — every language matches.
    expect(captured.value?.where).toBeUndefined();
    expect(hits[0]?.url).toBe("/o");

    await search("q", { locale: "fr" });
    expect(captured.value?.where).toStrictEqual({ locale: "fr" });
  });

  it("typesense searches the collection by the indexed fields", async () => {
    const captured: { value?: TypesenseSearchParams } = {};
    typesenseSearch = (params) => {
      captured.value = params;
      return Promise.resolve({
        hits: [
          {
            document: {
              content: "c",
              description: "d",
              title: "T",
              url: "/t",
              version: "current",
            },
          },
          {
            document: {
              content: "c2",
              description: "d2",
              title: "T1",
              url: "/v1.0/t",
              version: "v1.0",
            },
          },
        ],
      });
    };
    const { createSearch } =
      await import("../src/components/layout/search/typesense.ts");
    const search = createSearch({
      collection: "docs",
      host: "h",
      searchApiKey: "k",
    });
    const result = await search("q");
    expect(captured.value?.q).toBe("q");
    expect(captured.value?.query_by).toContain("title");
    // No locale option means no filter — every language matches.
    expect(captured.value?.filter_by).toBeUndefined();
    expect(result.hits[0]?.url).toBe("/t");
    // The document's version maps into the hit contract ("" = current) so the
    // cross-version badge works for hosted results too.
    expect(result.hits[0]?.version).toBe("");
    expect(result.hits[1]?.version).toBe("v1.0");

    await search("q", { locale: "fr" });
    expect(captured.value?.filter_by).toBe("locale:=fr");
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
      version: "current",
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
      deleted?: boolean;
      docs?: Record<string, unknown>[];
      options?: { action: string };
    } = {};
    typesenseRetrieve = () => Promise.reject(new Error("not found"));
    typesenseDelete = () => {
      captured.deleted = true;
      return Promise.resolve({});
    };
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
    // First run: no existing collection, so nothing to drop.
    expect(captured.deleted).toBeUndefined();
    expect(captured.created).toBe(true);
    expect(captured.options?.action).toBe("upsert");
    expect(captured.docs?.[0]?.id).toBe("/a");
  });

  it("typesense drops an existing collection before recreating it", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    const captured: { created?: boolean; deleted?: boolean } = {};
    typesenseRetrieve = () => Promise.resolve({});
    typesenseDelete = () => {
      captured.deleted = true;
      return Promise.resolve({});
    };
    typesenseCreate = (schema) => {
      captured.created = true;
      return Promise.resolve(schema);
    };
    typesenseImport = () => Promise.resolve([]);
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await syncTypesense(records, { collection: "docs", host: "h" });
    // A pre-existing collection is dropped so stale records don't survive.
    expect(captured.deleted).toBe(true);
    expect(captured.created).toBe(true);
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
