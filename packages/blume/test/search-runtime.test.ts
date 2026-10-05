import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createRequire } from "node:module";

import type { JsonValue } from "../src/core/adapter.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import {
  algolia,
  oramaCloud,
  typesense,
} from "../src/search/adapters/index.ts";
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
/** A hosted search record as the mock responses hand it back to a loader. */
interface HostedRecord {
  content: string;
  description: string;
  title: string;
  url: string;
  version?: string;
}
interface SaveObjectsArgs {
  indexName: string;
  objects: {
    content: string;
    locale: string;
    objectID: string;
    title: string;
    url: string;
  }[];
}
/** The slice of an Algolia index's settings the sync reads and writes. */
interface AlgoliaSettings {
  attributeForDistinct?: string;
  attributesForFaceting?: string[];
  customRanking?: string[];
  distinct?: boolean;
}
/** One `setSettings` call the Algolia sync made, and whether it was awaited. */
interface AlgoliaSettingsWrite {
  indexName: string;
  indexSettings: AlgoliaSettings;
  waited?: boolean;
}
interface TypesenseSearchParams {
  filter_by?: string;
  per_page: number;
  q: string;
  query_by: string;
  sort_by?: string;
}
interface TypesenseCollectionSchema {
  fields: {
    facet?: boolean;
    locale?: string;
    name: string;
    optional?: boolean;
    type: string;
  }[];
  name: string;
}
interface OramaCloudSearchParams {
  limit: number;
  term: string;
  where?: Record<string, string>;
}
/** The subset of an uploaded sync record the assertions read back. */
interface SyncedRecord {
  boost?: number;
  keywords?: string[];
  content: string;
  description: string;
  id: string;
  locale?: string;
  tag?: string;
  title: string;
  url: string;
  version?: string;
}
/** Mutable holder a mock implementation writes the captured call into. */
interface Captured<T> {
  value?: T;
}
interface CapturedRequest {
  body?: string;
  url?: Parameters<typeof globalThis.fetch>[0];
}
interface CapturedOramaSync {
  deployed?: boolean;
  snapshot?: SyncedRecord[];
}
/** The options a hosted SDK client was last constructed with. */
type ClientConfig = Record<string, JsonValue>;
interface ConstructedClients {
  algolia?: [appId: string, apiKey: string, options?: ClientConfig];
  oramaCloud?: ClientConfig;
  typesense?: ClientConfig;
}
/** What the mocked Typesense server holds, and what the sync did to it. */
interface TypesenseServer {
  /** The alias's collection, or the error looking it up fails with. */
  alias?: string | Error;
  /** A collection holds the alias's name itself (a sync from before aliases). */
  legacy?: boolean;
  importError?: Error;
  /** Each call the sync made, in order, with the collection it named. */
  calls: string[];
  schema?: TypesenseCollectionSchema;
  docs?: SyncedRecord[];
  options?: { action: string };
}

// --- Mutable SDK behaviors the module mocks delegate to (set per test) ---
const constructed: ConstructedClients = {};
let algoliaSearch: (
  params: AlgoliaSearchParams
) => Promise<{ results: { hits: HostedRecord[] }[] }>;
let algoliaSave: (args: SaveObjectsArgs) => Promise<void>;
let algoliaSettings: AlgoliaSettings = {};
const algoliaSettingsWrites: AlgoliaSettingsWrite[] = [];
let oramaCloudSearch: (
  query: OramaCloudSearchParams
) => Promise<{ hits: { document: HostedRecord }[] }>;
let cloudSnapshot: (data: SyncedRecord[]) => Promise<boolean>;
let cloudDeploy: () => Promise<boolean>;
let typesenseSearch: (
  params: TypesenseSearchParams
) => Promise<{ hits: { document: HostedRecord }[] }>;
let typesenseServer: TypesenseServer = { calls: [] };
/** The SDK's 404, which the sync reads as "no such alias". */
class TypesenseNotFoundError extends Error {
  override name = "TypesenseNotFoundError";
}

// Turn an object factory into a `new`-able constructor — the SDKs are used as
// `new Client(...)` etc., and a function invoked with `new` that returns an
// object yields that object.
const asConstructor = <T extends object>(
  make: (config: ClientConfig) => T
): new (config: ClientConfig) => T => {
  const construct = function construct(config: ClientConfig) {
    return make(config);
  };
  // SAFETY: `new construct()` returns the object `make` builds, so the
  // callable behaves exactly as the `new () => T` constructor it is used as.
  return construct as never;
};

// The hosted syncs load their SDK with Node's `require` (see
// `core/node-require.ts`), which resolves a dual ESM/CommonJS package to its
// CommonJS build rather than the ESM entry a bare `mock.module` specifier maps
// to, so each synced SDK is mocked under both.
const resolveRequired = createRequire(import.meta.url).resolve;
const mockSdk = (
  specifier: string,
  factory: Parameters<typeof mock.module>[1]
): void => {
  mock.module(specifier, factory);
  mock.module(resolveRequired(specifier), factory);
};

mock.module("algoliasearch/lite", () => ({
  liteClient: (appId: string, apiKey: string, options?: ClientConfig) => {
    constructed.algolia = [appId, apiKey, options];
    return {
      search: (params: AlgoliaSearchParams) => algoliaSearch(params),
    };
  },
}));
mockSdk("algoliasearch", () => ({
  algoliasearch: () => ({
    getSettings: () => Promise.resolve(algoliaSettings),
    replaceAllObjects: (args: SaveObjectsArgs) => algoliaSave(args),
    setSettings: (args: AlgoliaSettingsWrite) => {
      algoliaSettingsWrites.push(args);
      return Promise.resolve({ taskID: algoliaSettingsWrites.length });
    },
    waitForTask: ({ taskID }: { taskID: number }) => {
      const write = algoliaSettingsWrites[taskID - 1];
      if (write) {
        write.waited = true;
      }
      return Promise.resolve({ status: "published" });
    },
  }),
}));
mockSdk("@oramacloud/client", () => ({
  CloudManager: asConstructor(() => ({
    index: () => ({
      deploy: () => cloudDeploy(),
      snapshot: (data: SyncedRecord[]) => cloudSnapshot(data),
    }),
  })),
  OramaClient: asConstructor((config) => {
    constructed.oramaCloud = config;
    return {
      search: (query: OramaCloudSearchParams) => oramaCloudSearch(query),
    };
  }),
}));
// Hoisted out of the mock factory so its inner methods don't nest past the
// four-level depth limit (mock.module → constructor → collections → documents).
const typesenseDocuments = (name?: string) => ({
  import: (docs: SyncedRecord[], options: { action: string }) => {
    typesenseServer.calls.push(`import ${name}`);
    typesenseServer.docs = docs;
    typesenseServer.options = options;
    return typesenseServer.importError
      ? Promise.reject(typesenseServer.importError)
      : Promise.resolve([{ success: true }]);
  },
  search: (params: TypesenseSearchParams) => typesenseSearch(params),
});
const typesenseCollection = (name?: string) => ({
  create: (schema: TypesenseCollectionSchema) => {
    typesenseServer.calls.push(`create ${schema.name}`);
    typesenseServer.schema = schema;
    return Promise.resolve(schema);
  },
  delete: () => {
    typesenseServer.calls.push(`delete ${name}`);
    return Promise.resolve({ name });
  },
  documents: () => typesenseDocuments(name),
  retrieve: () =>
    typesenseServer.legacy
      ? Promise.resolve({ name })
      : Promise.reject(new TypesenseNotFoundError()),
});
const typesenseAliases = (name?: string) => ({
  retrieve: () => {
    const { alias } = typesenseServer;
    if (alias instanceof Error) {
      return Promise.reject(alias);
    }
    return alias === undefined
      ? Promise.reject(new TypesenseNotFoundError())
      : Promise.resolve({ collection_name: alias, name });
  },
  upsert: (alias: string, mapping: { collection_name: string }) => {
    typesenseServer.calls.push(`alias ${alias} ${mapping.collection_name}`);
    return Promise.resolve({ ...mapping, name: alias });
  },
});
mockSdk("typesense", () => ({
  Client: asConstructor((config) => {
    constructed.typesense = config;
    return { aliases: typesenseAliases, collections: typesenseCollection };
  }),
  Errors: { ObjectNotFound: TypesenseNotFoundError },
}));

const INDEX = [
  { content: "alpha body", description: "", route: "/a", title: "Alpha" },
  { content: "beta content", description: "", route: "/b", title: "Beta" },
];

let originalFetch: typeof globalThis.fetch;
const stubFetch = (
  impl: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>
): void => {
  // SAFETY: the loaders under test only call fetch; Bun's extra fetch statics
  // (like preconnect) are never touched.
  globalThis.fetch = impl as typeof globalThis.fetch;
};

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** An Orama Cloud hit for `url` with its score and page boost. */
const cloudHit = (url: string, score: number, boost?: number) => ({
  document: { boost, content: "", description: "", title: url, url },
  score,
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

  it("flexsearch ranks a boosted page above the pages it ties with", async () => {
    stubFetch(() =>
      Promise.resolve(
        Response.json([
          { content: "widget", description: "", route: "/a", title: "A" },
          {
            boost: 5,
            content: "widget",
            description: "",
            route: "/b",
            title: "B",
          },
          {
            content: "",
            description: "",
            keywords: ["gizmo"],
            route: "/c",
            title: "C",
          },
        ])
      )
    );
    const { createSearch } =
      await import("../src/components/layout/search/flexsearch.ts");
    const search = await createSearch({ indexUrl: "/blume-search.json" });
    const widget = await search("widget");
    expect(widget.hits.map((hit) => hit.url)).toStrictEqual(["/b", "/a"]);
    const gizmo = await search("gizmo");
    expect(gizmo.hits.map((hit) => hit.url)).toStrictEqual(["/c"]);
  });

  it("endpoint posts the query and returns the server's hits", async () => {
    const captured: CapturedRequest = {};
    stubFetch((url, init) => {
      // SAFETY: the endpoint loader always POSTs a JSON string body.
      captured.body = init?.body as string;
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
    const captured: Captured<AlgoliaSearchParams> = {};
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
              // A later record of the same page (a long page the sync
              // split) adds no second row.
              {
                content: "c, continued",
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
      apiKey: "key",
      appId: "app",
      indexName: "docs",
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
    expect(hits.map((hit) => hit.url)).toStrictEqual(["/a", "/b"]);

    await search("q", { locale: "fr" });
    expect(captured.value?.requests[0]?.facetFilters).toStrictEqual([
      "locale:fr",
    ]);
  });

  it("orama-cloud queries the hosted index", async () => {
    const captured: Captured<OramaCloudSearchParams> = {};
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

  it("orama-cloud re-ranks a pool of hits by each page's boost", async () => {
    const captured: Captured<OramaCloudSearchParams> = {};
    oramaCloudSearch = (query) => {
      captured.value = query;
      return Promise.resolve({
        hits: [cloudHit("/a", 3), cloudHit("/b", 2, 2), cloudHit("/c", 1)],
      });
    };
    const { createSearch } =
      await import("../src/components/layout/search/orama-cloud.ts");
    const { hits } = await createSearch({ apiKey: "k", endpoint: "https://x" })(
      "q"
    );
    // /b's 2 × 2 beats /a's 3: the pool is fetched past the visible limit.
    expect(hits.map((each) => each.url)).toStrictEqual(["/b", "/a", "/c"]);
    expect(captured.value?.limit).toBeGreaterThan(12);
  });

  it("typesense searches the collection by the indexed fields", async () => {
    const captured: Captured<TypesenseSearchParams> = {};
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
      apiKey: "k",
      collection: "docs",
      host: "h",
    });
    const result = await search("q");
    expect(captured.value?.q).toBe("q");
    expect(captured.value?.query_by).toBe("title,keywords,description,content");
    // Relevance first; boost only orders equally good matches.
    expect(captured.value?.sort_by).toBe("_text_match:desc,boost:desc");
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

  it("hosted clients hand the options Blume doesn't read to their SDK", async () => {
    const algoliaClient =
      await import("../src/components/layout/search/algolia.ts");
    algoliaClient.createSearch({
      apiKey: "key",
      appId: "app",
      indexName: "docs",
      timeouts: { connect: 2, read: 5 },
    });
    expect(constructed.algolia).toStrictEqual([
      "app",
      "key",
      { timeouts: { connect: 2, read: 5 } },
    ]);

    const oramaCloudClient =
      await import("../src/components/layout/search/orama-cloud.ts");
    oramaCloudClient.createSearch({
      apiKey: "k",
      endpoint: "https://x",
      // The sync's option, never the browser client's.
      indexId: "i",
      telemetry: false,
    });
    expect(constructed.oramaCloud).toStrictEqual({
      api_key: "k",
      endpoint: "https://x",
      telemetry: false,
    });

    const typesenseClient =
      await import("../src/components/layout/search/typesense.ts");
    typesenseClient.createSearch({
      apiKey: "k",
      collection: "docs",
      connectionTimeoutSeconds: 5,
      host: "h",
      // The sync's option, never the browser client's.
      locale: "ja",
      // The named connection options decide the node list.
      nodes: [{ host: "other", port: 80, protocol: "http" }],
      port: 8108,
      protocol: "http",
    });
    expect(constructed.typesense).toStrictEqual({
      apiKey: "k",
      connectionTimeoutSeconds: 5,
      nodes: [{ host: "h", port: 8108, protocol: "http" }],
    });
  });
});

/** An uploaded Algolia object's size, as Algolia measures it. */
const algoliaBytes = (object: SaveObjectsArgs["objects"][number]): number =>
  Buffer.byteLength(JSON.stringify(object), "utf-8");

/** A project with no pages, configured with `search`. */
const syncProject = (search: BlumeConfigInput["search"]): BlumeProject => {
  const config = blumeConfigSchema.parse({ search });
  return {
    config,
    context: {
      componentsFile: null,
      configFile: null,
      contentRoot: "/tmp/docs",
      outDir: "/tmp/.blume",
      pagesRoot: null,
      root: "/tmp",
      themeFile: null,
    },
    diagnostics: [],
    droppedPages: 0,
    graph: {
      diagnostics: [],
      navigation: { featured: [], selectors: [], sidebar: [], tabs: [] },
      navigationByLocale: {},
      navigationByVersion: {},
      pages: [],
      routes: new Map(),
    },
    manifest: {
      blumeVersion: "0.0.0",
      contentRoot: "/tmp/docs",
      output: config.deployment.options.output,
      projectRoot: "/tmp",
      routes: [],
      version: 1,
    },
    mode: "build",
    sources: [],
    themeFontsConfigured: false,
  };
};

/** Every object the next Algolia sync uploads, captured. */
const captureAlgolia = (): Captured<SaveObjectsArgs> => {
  const captured: Captured<SaveObjectsArgs> = {};
  algoliaSave = (args) => {
    captured.value = args;
    return Promise.resolve();
  };
  return captured;
};

/** The sync's calls, with each timestamped collection name as `docs_<n>`. */
const typesenseCalls = (): string[] =>
  typesenseServer.calls.map((call) => call.replaceAll(/_\d+/gu, "_<n>"));

describe("hosted sync uploads", () => {
  const page = {
    _id: "/a",
    boost: 2,
    content: "c",
    description: "d",
    keywords: ["setup"],
    locale: "en",
    tag: "guides",
    title: "A",
    url: "/a",
    version: "current",
  };
  const records = [page];

  it("algolia uploads objects keyed by objectID", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    const captured: Captured<SaveObjectsArgs> = {};
    algoliaSave = (args) => {
      captured.value = args;
      return Promise.resolve();
    };
    const { syncAlgolia } = await import("../src/search/sync/algolia.ts");
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(captured.value?.indexName).toBe("docs");
    expect(captured.value?.objects[0]?.objectID).toBe("/a");
  });

  const DECLARED: AlgoliaSettings = {
    attributesForFaceting: ["filterOnly(locale)", "filterOnly(version)"],
    customRanking: ["desc(boost)"],
  };

  it("algolia splits a page too long for one record, listing it once by url", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    const captured = captureAlgolia();
    algoliaSettings = DECLARED;
    algoliaSettingsWrites.length = 0;
    const words = Array.from({ length: 4000 }, (_, index) => `word${index}`);
    const long = {
      ...page,
      _id: "/long",
      content: words.join(" "),
      url: "/long",
    };
    const { syncAlgolia } = await import("../src/search/sync/algolia.ts");
    await syncAlgolia([page, long], { appId: "app", indexName: "docs" });
    const objects = captured.value?.objects ?? [];
    // The short page stays one record under its own id.
    expect(objects[0]?.objectID).toBe("/a");
    const pieces = objects.slice(1);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((piece) => piece.objectID)).toStrictEqual(
      pieces.map((_, index) => (index === 0 ? "/long" : `/long#${index}`))
    );
    // Each piece fits Algolia's cap and carries the page's own fields, and
    // the body is cut between words.
    for (const piece of pieces) {
      expect(algoliaBytes(piece)).toBeLessThanOrEqual(10_000);
      expect(piece).toMatchObject({ locale: "en", title: "A", url: "/long" });
    }
    expect(pieces.map((piece) => piece.content).join(" ")).toBe(long.content);
    expect(algoliaSettingsWrites[0]?.indexSettings).toStrictEqual({
      ...DECLARED,
      attributeForDistinct: "url",
      distinct: true,
    });
  });

  it("algolia cuts an unspaced script between characters", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    const captured = captureAlgolia();
    algoliaSettings = DECLARED;
    // 3 bytes a character, no spaces: 15,000 bytes of body.
    const content = "検索".repeat(2500);
    const { syncAlgolia } = await import("../src/search/sync/algolia.ts");
    await syncAlgolia([{ ...page, content }], {
      appId: "app",
      indexName: "docs",
    });
    const objects = captured.value?.objects ?? [];
    expect(objects).toHaveLength(2);
    for (const piece of objects) {
      expect(algoliaBytes(piece)).toBeLessThanOrEqual(10_000);
    }
    expect(objects.map((piece) => piece.content).join("")).toBe(content);
  });

  it("algolia keeps the site's own distinct attribute, and uploads whole what can't split", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    const captured = captureAlgolia();
    algoliaSettings = { ...DECLARED, attributeForDistinct: "section" };
    algoliaSettingsWrites.length = 0;
    const { syncAlgolia } = await import("../src/search/sync/algolia.ts");
    const long = { ...page, content: "word ".repeat(3000) };
    await syncAlgolia([long], { appId: "app", indexName: "docs" });
    expect(captured.value?.objects.length).toBeGreaterThan(1);
    expect(algoliaSettingsWrites).toStrictEqual([]);

    // A title alone past the cap leaves no room for any body: the record
    // goes up whole, and Algolia's rejection names it.
    const huge = { ...page, content: "body", title: "t".repeat(12_000) };
    await syncAlgolia([huge], { appId: "app", indexName: "docs" });
    expect(
      captured.value?.objects.map((piece) => piece.objectID)
    ).toStrictEqual(["/a"]);
  });

  it("algolia declares the locale and version filters, keeping the site's own facets", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    algoliaSave = () => Promise.resolve();
    const { syncAlgolia } = await import("../src/search/sync/algolia.ts");

    // The dialog's facetFilters only match declared attributes.
    algoliaSettings = { attributesForFaceting: ["searchable(tag)"] };
    algoliaSettingsWrites.length = 0;
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(algoliaSettingsWrites).toStrictEqual([
      {
        indexName: "docs",
        indexSettings: {
          attributesForFaceting: [
            "searchable(tag)",
            "filterOnly(locale)",
            "filterOnly(version)",
          ],
          // Close matches order by search.boost.
          customRanking: ["desc(boost)"],
        },
        waited: true,
      },
    ]);

    // Only what's missing is added; a fresh index has no settings at all.
    algoliaSettings = { attributesForFaceting: ["locale"] };
    algoliaSettingsWrites.length = 0;
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(
      algoliaSettingsWrites[0]?.indexSettings.attributesForFaceting
    ).toStrictEqual(["locale", "filterOnly(version)"]);
    algoliaSettings = {};
    algoliaSettingsWrites.length = 0;
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(
      algoliaSettingsWrites[0]?.indexSettings.attributesForFaceting
    ).toStrictEqual(["filterOnly(locale)", "filterOnly(version)"]);

    // The site's own ranking keeps its place ahead of the boost.
    algoliaSettings = {
      attributesForFaceting: ["filterOnly(locale)", "filterOnly(version)"],
      customRanking: ["desc(popularity)"],
    };
    algoliaSettingsWrites.length = 0;
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(algoliaSettingsWrites[0]?.indexSettings.customRanking).toStrictEqual(
      ["desc(popularity)", "desc(boost)"]
    );

    // Already declared: the settings are left alone.
    algoliaSettings = {
      attributesForFaceting: ["filterOnly(locale)", "filterOnly(version)"],
      customRanking: ["asc(boost)"],
    };
    algoliaSettingsWrites.length = 0;
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(algoliaSettingsWrites).toStrictEqual([]);

    // Facets declared but no boost ranking: only the ranking is added.
    algoliaSettings = {
      attributesForFaceting: ["filterOnly(locale)", "filterOnly(version)"],
    };
    algoliaSettingsWrites.length = 0;
    await syncAlgolia(records, { appId: "app", indexName: "docs" });
    expect(algoliaSettingsWrites[0]?.indexSettings).toStrictEqual({
      attributesForFaceting: ["filterOnly(locale)", "filterOnly(version)"],
      customRanking: ["desc(boost)"],
    });
  });

  it("orama-cloud snapshots the records and deploys", async () => {
    process.env.ORAMA_PRIVATE_API_KEY = "private";
    const captured: CapturedOramaSync = {};
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
    const first = captured.snapshot?.[0];
    expect(first?.id).toBe("/a");
    expect(first?.boost).toBe(2);
    expect(first?.keywords).toStrictEqual(["setup"]);
    expect(captured.deployed).toBe(true);
  });

  it("typesense imports into a new collection and points the alias at it", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    typesenseServer = { calls: [] };
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await syncTypesense(records, { collection: "docs", host: "h" });
    // First run: no alias and no collection of that name, so nothing to drop.
    expect(typesenseCalls()).toStrictEqual([
      "create docs_<n>",
      "import docs_<n>",
      "alias docs docs_<n>",
    ]);
    expect(typesenseServer.options?.action).toBe("upsert");
    expect(typesenseServer.docs?.[0]).toMatchObject({
      boost: 2,
      id: "/a",
      keywords: ["setup"],
    });
    // The collection sorts by boost and searches keywords.
    expect(
      typesenseServer.schema?.fields.filter((field) =>
        ["boost", "keywords"].includes(field.name)
      )
    ).toStrictEqual([
      { name: "keywords", optional: true, type: "string[]" },
      { name: "boost", type: "float" },
    ]);

    // A record without keywords uploads an empty list.
    const bare = {
      _id: "/b",
      boost: 1,
      content: "",
      description: "",
      locale: "en",
      title: "B",
      url: "/b",
      version: "current",
    };
    await syncTypesense([bare], { collection: "docs", host: "h" });
    expect(typesenseServer.docs?.[0]?.keywords).toStrictEqual([]);
    // No locale: every field keeps Typesense's default tokenizer.
    expect(typesenseServer.schema?.fields.some((field) => field.locale)).toBe(
      false
    );
  });

  it("typesense tokenizes the searched text fields for the adapter's locale", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    typesenseServer = { calls: [] };
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await syncTypesense(records, {
      collection: "docs",
      host: "h",
      locale: "ja",
    });
    const localized = typesenseServer.schema?.fields
      .filter((field) => field.locale === "ja")
      .map((field) => field.name);
    expect(localized).toStrictEqual([
      "title",
      "description",
      "content",
      "keywords",
    ]);
  });

  it("typesense swaps the alias, then drops the collection it replaced", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    typesenseServer = { alias: "docs_1", calls: [] };
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await syncTypesense(records, { collection: "docs", host: "h" });
    // Searches read docs_1 until the alias moves, so none see a partial index.
    expect(typesenseCalls()).toStrictEqual([
      "create docs_<n>",
      "import docs_<n>",
      "alias docs docs_<n>",
      "delete docs_<n>",
    ]);
    expect(typesenseServer.calls.at(-1)).toBe("delete docs_1");
  });

  it("typesense replaces a collection from before the alias under its name", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    typesenseServer = { calls: [], legacy: true };
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await syncTypesense(records, { collection: "docs", host: "h" });
    // An alias can't share a collection's name: the old collection goes once
    // the new one is complete, and the alias takes the name straight after.
    expect(typesenseCalls()).toStrictEqual([
      "create docs_<n>",
      "import docs_<n>",
      "delete docs",
      "alias docs docs_<n>",
    ]);
  });

  it("typesense keeps the previous collection serving when the import fails", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    typesenseServer = {
      alias: "docs_1",
      calls: [],
      importError: new Error("1 documents failed during import"),
    };
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await expect(
      syncTypesense(records, { collection: "docs", host: "h" })
    ).rejects.toThrow("failed during import");
    // The half-built collection goes; the alias never moved off docs_1.
    expect(typesenseCalls()).toStrictEqual([
      "create docs_<n>",
      "import docs_<n>",
      "delete docs_<n>",
    ]);
    expect(typesenseServer.calls).not.toContain("delete docs_1");
  });

  it("typesense stops before building anything when the alias lookup fails", async () => {
    process.env.TYPESENSE_ADMIN_API_KEY = "admin";
    typesenseServer = { alias: new Error("Forbidden"), calls: [] };
    const { syncTypesense } = await import("../src/search/sync/typesense.ts");
    await expect(
      syncTypesense(records, { collection: "docs", host: "h" })
    ).rejects.toThrow("Forbidden");
    expect(typesenseServer.calls).toStrictEqual([]);
  });

  it("the dispatcher runs the provider sync and reports success", async () => {
    process.env.ALGOLIA_ADMIN_API_KEY = "admin";
    const captured: Captured<SaveObjectsArgs> = {};
    algoliaSave = (args) => {
      captured.value = args;
      return Promise.resolve();
    };
    const messages: string[] = [];
    await syncSearchProvider(
      syncProject(algolia({ apiKey: "k", appId: "app", indexName: "docs" })),
      {
        start: (message) => messages.push(message),
        success: (message) => messages.push(message),
        warn: (message) => messages.push(message),
      }
    );
    expect(captured.value?.indexName).toBe("docs");
    expect(messages.some((message) => message.includes("Synced"))).toBe(true);
  });

  // With its admin key set, a hosted adapter's failed sync fails the build
  // instead of deploying the site against an index it didn't update. (Unset,
  // the sync warns and skips: see search-providers.test.ts.)
  const failingSyncs = [
    {
      env: "ALGOLIA_ADMIN_API_KEY",
      fail: () => {
        algoliaSave = () => Promise.reject(new Error("Invalid API key"));
      },
      search: algolia({ apiKey: "k", appId: "app", indexName: "docs" }),
    },
    {
      env: "ORAMA_PRIVATE_API_KEY",
      fail: () => {
        cloudSnapshot = () => Promise.reject(new Error("Invalid API key"));
      },
      search: oramaCloud({
        apiKey: "k",
        endpoint: "https://x.orama.run",
        indexId: "idx",
      }),
    },
    {
      env: "TYPESENSE_ADMIN_API_KEY",
      fail: () => {
        typesenseServer = { alias: new Error("Invalid API key"), calls: [] };
      },
      search: typesense({ apiKey: "k", collection: "docs", host: "h" }),
    },
  ];

  for (const { env, fail, search } of failingSyncs) {
    it(`fails the build when ${search.kind} has ${env} but its sync fails`, async () => {
      process.env[env] = "admin";
      fail();
      const warnings: string[] = [];
      try {
        await expect(
          syncSearchProvider(syncProject(search), {
            start: () => 0,
            success: () => 0,
            warn: (message) => warnings.push(message),
          })
        ).rejects.toMatchObject({
          diagnostic: {
            code: "BLUME_SEARCH_SYNC_FAILED",
            message: `Search sync to ${search.kind} failed: Invalid API key`,
            severity: "error",
          },
        });
      } finally {
        Reflect.deleteProperty(process.env, env);
      }
      expect(warnings).toStrictEqual([]);
    });
  }
});
