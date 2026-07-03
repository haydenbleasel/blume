import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  constraints,
  exampleValue,
  isNullable,
  objectProperties,
  refName,
  resolveSchema,
  toJson,
  typeLabel,
} from "../src/components/openapi/helpers.ts";
import type { SchemaLike } from "../src/components/openapi/helpers.ts";
import {
  buildRequestSample,
  sampleLanguages,
} from "../src/components/openapi/snippets.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import type { ProjectContext } from "../src/core/types.ts";
import {
  extractOperations,
  operationKey,
  operationObject,
} from "../src/openapi/model.ts";
import type { ApiDocument, ApiSpecData } from "../src/openapi/model.ts";
import { parseSpec } from "../src/openapi/parse.ts";
import {
  blumeReferences,
  hasScalarReferences,
  resolveReferences,
} from "../src/openapi/references.ts";
import { operationMdx, overviewMdx } from "../src/openapi/render-mdx.ts";
import { isOpenApiSource, openApiSource } from "../src/openapi/source.ts";

const ctx = (projectRoot: string) => ({
  cacheDir: join(projectRoot, ".blume/cache/openapi"),
  mode: "build" as const,
  projectRoot,
});

const SPEC_3_1 = {
  components: {
    schemas: {
      Pet: {
        properties: {
          id: { format: "int64", type: "integer" },
          name: { example: "doggie", type: "string" },
          status: { enum: ["available", "sold"], type: "string" },
          tags: { items: { $ref: "#/components/schemas/Tag" }, type: "array" },
        },
        required: ["name"],
        type: "object",
      },
      Tag: {
        // Self-referential to exercise the circular-ref guard.
        properties: {
          child: { $ref: "#/components/schemas/Tag" },
          name: { type: "string" },
        },
        type: "object",
      },
    },
  },
  info: { description: "A pet store.", title: "Petstore", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/pet": {
      post: {
        operationId: "addPet",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
            description: "OK",
          },
          "404": { description: "Not found" },
        },
        summary: "Add a pet",
        tags: ["pet"],
      },
    },
    "/pet/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          {
            in: "path",
            name: "petId",
            required: true,
            schema: { type: "integer" },
          },
        ],
        summary: "Find a pet",
        tags: ["pet"],
      },
    },
    "/ping": {
      // No tag and no operationId, to exercise the fallbacks.
      get: { responses: { "200": { description: "pong" } } },
    },
  },
  servers: [{ url: "https://api.test/v1" }],
} as unknown as ApiDocument;

const tempSpec = async (contents: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-openapi-"));
  const file = join(dir, "spec.json");
  await writeFile(file, JSON.stringify(contents));
  return dir;
};

/** A `fetch` stub that always resolves to the given response. */
const respondWith = (response: Response): typeof fetch =>
  (() => Promise.resolve(response)) as unknown as typeof fetch;

// A `fetch` stub that yields queued responses (repeating the last), and records
// how many times it was called plus the last init it received.
const queued = (responses: Response[]) => {
  let count = 0;
  let lastInit: RequestInit | undefined;
  const stub = ((_url: string, init?: RequestInit) => {
    lastInit = init;
    const response = responses[Math.min(count, responses.length - 1)];
    count += 1;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return {
    get calls() {
      return count;
    },
    fetch: stub,
    get lastInit() {
      return lastInit;
    },
  };
};

describe("references", () => {
  it("resolves a Blume-rendered OpenAPI reference by default", () => {
    const config = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "spec.json" },
    });
    const refs = resolveReferences(config);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.renderer).toBe("blume");
    expect(refs[0]?.slug).toBe("reference");
    expect(refs[0]?.display).toStrictEqual({
      codeSamples: ["curl", "js", "python"],
      expandSchemas: false,
    });
    expect(hasScalarReferences(config)).toBe(false);
    expect(blumeReferences(config)).toHaveLength(1);
  });

  it("keeps AsyncAPI on the Scalar renderer", () => {
    const config = blumeConfigSchema.parse({
      asyncapi: { enabled: true, spec: "async.yaml" },
    });
    expect(hasScalarReferences(config)).toBe(true);
    expect(blumeReferences(config)).toStrictEqual([]);
    expect(resolveReferences(config)[0]?.renderer).toBe("scalar");
  });

  it("dedupes Blume references that resolve to the same route", () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        sources: [
          { route: "/api", spec: "a.json" },
          { route: "/api", spec: "b.json" },
        ],
      },
    });
    expect(blumeReferences(config)).toHaveLength(1);
  });

  it("appends a staged openapi source when a Blume reference is configured", () => {
    const config = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "spec.json" },
    });
    const context = {
      contentRoot: "/p/docs",
      outDir: "/p/.blume",
      root: "/p",
    } as ProjectContext;

    // The implicit filesystem source, plus the staged OpenAPI source.
    const sources = resolveSources(config, context, { mode: "build" });
    expect(sources).toHaveLength(2);
    expect(sources[1]?.name).toBe("openapi");
    expect(sources[1]?.staged).toBe(true);
  });
});

describe("model.extractOperations", () => {
  it("flattens operations, groups by tag, and maps routes", () => {
    const { operations, tags } = extractOperations(SPEC_3_1, "/api");
    const byKey = new Map(operations.map((op) => [op.key, op]));
    expect(operations).toHaveLength(3);
    expect(byKey.get("addpet")?.route).toBe("/api/pet/addpet");
    expect(byKey.get("addpet")?.method).toBe("post");
    expect(tags.map((tag) => tag.slug)).toContain("pet");
    // Untagged operation falls back to the "Operations" group.
    const ping = operations.find((op) => op.path === "/ping");
    expect(ping?.tag).toBe("Operations");
    expect(ping?.route).toBe("/api/operations/get-ping");
  });

  it("derives an operation key from method+path when operationId is absent", () => {
    expect(operationKey("get", "/pets/{id}")).toBe("get-pets-id");
    expect(operationKey("get", "/pets", "listPets")).toBe("listpets");
  });

  it("de-duplicates a repeated operationId across operations", () => {
    const { operations } = extractOperations(
      {
        openapi: "3.1.0",
        paths: {
          "/a": { get: { operationId: "dup" } },
          "/b": { post: { operationId: "dup" } },
        },
      } as unknown as ApiDocument,
      "/api"
    );
    const keys = operations.map((op) => op.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("dup");
  });

  it("carries tag descriptions from the document's top-level tags", () => {
    const { tags } = extractOperations(
      {
        openapi: "3.1.0",
        paths: { "/x": { get: { operationId: "x", tags: ["pet"] } } },
        tags: [{ description: "Pet ops", name: "pet" }],
      } as unknown as ApiDocument,
      "/api"
    );
    expect(tags).toStrictEqual([
      { description: "Pet ops", name: "pet", slug: "pet" },
    ]);
  });

  it("resolves an operation object out of its spec document", () => {
    const { operations } = extractOperations(SPEC_3_1, "/api");
    const spec = { document: SPEC_3_1 } as unknown as ApiSpecData;
    const addPet = operations.find((op) => op.key === "addpet");
    if (!addPet) {
      throw new Error("addpet operation missing");
    }
    expect(operationObject(spec, addPet)?.summary).toBe("Add a pet");
    expect(
      operationObject(spec, { ...addPet, path: "/missing" })
    ).toBeUndefined();
  });
});

describe("parse.parseSpec", () => {
  it("reads and upgrades a Swagger 2.0 spec to 3.1", async () => {
    const dir = await tempSpec({
      info: { title: "Legacy", version: "1" },
      paths: {},
      swagger: "2.0",
    });
    const { document } = await parseSpec("spec.json", dir);
    expect(document.openapi?.startsWith("3.1")).toBe(true);
    expect(document.info?.title).toBe("Legacy");
    await rm(dir, { force: true, recursive: true });
  });

  it("throws on a missing spec", async () => {
    await expect(parseSpec("nope.json", "/does/not/exist")).rejects.toThrow();
  });

  it("fetches and parses a remote spec, and throws on a bad response", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = respondWith(
      Response.json({
        info: { title: "Remote", version: "1" },
        openapi: "3.0.0",
        paths: {},
      })
    );
    try {
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/"
      );
      expect(document.info?.title).toBe("Remote");
      globalThis.fetch = respondWith(new Response("nope", { status: 404 }));
      await expect(
        parseSpec("https://api.test/missing.json", "/")
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("parse.parseSpec remote hardening", () => {
  const remoteSpec = {
    info: { title: "Remote", version: "1" },
    openapi: "3.0.0",
    paths: {},
  };

  it("retries a transient 5xx, sends a User-Agent, and succeeds", async () => {
    const original = globalThis.fetch;
    const stub = queued([
      new Response("busy", { status: 503 }),
      Response.json(remoteSpec),
    ]);
    globalThis.fetch = stub.fetch;
    try {
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/"
      );
      expect(document.info?.title).toBe("Remote");
      expect(stub.calls).toBe(2);
      const headers = stub.lastInit?.headers as Record<string, string>;
      expect(headers["user-agent"]).toContain("blume");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives up after repeated failures and throws", async () => {
    const original = globalThis.fetch;
    const stub = queued([new Response("down", { status: 502 })]);
    globalThis.fetch = stub.fetch;
    try {
      await expect(
        parseSpec("https://api.test/openapi.json", "/")
      ).rejects.toThrow(/502/u);
      expect(stub.calls).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("retries a thrown network error, then rethrows it", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("ECONNRESET"));
    }) as unknown as typeof fetch;
    try {
      await expect(
        parseSpec("https://api.test/openapi.json", "/")
      ).rejects.toThrow(/ECONNRESET/u);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("dev cache-first with no cached copy falls through to the network", async () => {
    const original = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), "blume-openapi-cache-"));
    const stub = queued([Response.json(remoteSpec)]);
    globalThis.fetch = stub.fetch;
    try {
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/",
        { cacheDir, refresh: false }
      );
      expect(document.info?.title).toBe("Remote");
      expect(stub.calls).toBe(1);
    } finally {
      globalThis.fetch = original;
      await rm(cacheDir, { force: true, recursive: true });
    }
  });

  it("routes through a proxy when a *_PROXY env var is set", async () => {
    const original = globalThis.fetch;
    const hadProxy = process.env.HTTPS_PROXY;
    const { getGlobalDispatcher, setGlobalDispatcher } = await import("undici");
    const previous = getGlobalDispatcher();
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    globalThis.fetch = queued([Response.json(remoteSpec)]).fetch;
    try {
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/"
      );
      expect(document.info?.title).toBe("Remote");
    } finally {
      globalThis.fetch = original;
      setGlobalDispatcher(previous);
      if (hadProxy === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = hadProxy;
      }
    }
  });

  it("caches a good fetch and serves it when a later fetch fails", async () => {
    const original = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), "blume-openapi-cache-"));
    try {
      globalThis.fetch = queued([Response.json(remoteSpec)]).fetch;
      const first = await parseSpec("https://api.test/openapi.json", "/", {
        cacheDir,
        refresh: true,
      });
      expect(first.warnings).toStrictEqual([]);

      // A 404 is non-retryable, so this fails fast and falls back to the cache.
      globalThis.fetch = queued([new Response("gone", { status: 404 })]).fetch;
      const second = await parseSpec("https://api.test/openapi.json", "/", {
        cacheDir,
        refresh: true,
      });
      expect(second.document.info?.title).toBe("Remote");
      expect(second.warnings[0]).toContain("last cached copy");
    } finally {
      globalThis.fetch = original;
      await rm(cacheDir, { force: true, recursive: true });
    }
  });

  it("is cache-first in dev: a cached spec skips the network", async () => {
    const original = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), "blume-openapi-cache-"));
    try {
      // Prime the cache with a build-style refresh.
      globalThis.fetch = queued([Response.json(remoteSpec)]).fetch;
      await parseSpec("https://api.test/openapi.json", "/", {
        cacheDir,
        refresh: true,
      });

      // Dev (refresh: false) must not touch the network, even if it would fail.
      const offline = queued([new Response("nope", { status: 500 })]);
      globalThis.fetch = offline.fetch;
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/",
        { cacheDir, refresh: false }
      );
      expect(document.info?.title).toBe("Remote");
      expect(offline.calls).toBe(0);
    } finally {
      globalThis.fetch = original;
      await rm(cacheDir, { force: true, recursive: true });
    }
  });
});

describe("render-mdx", () => {
  const specData = (over: Partial<ApiSpecData> = {}): ApiSpecData =>
    ({
      codeSamples: [],
      description: "",
      document: SPEC_3_1,
      expandSchemas: false,
      label: "API",
      operations: {},
      route: "/api",
      slug: "api",
      tags: [],
      title: "API",
      version: "1",
      ...over,
    }) as ApiSpecData;

  it("renders an operation page with searchable frontmatter and a component body", () => {
    const { operations } = extractOperations(SPEC_3_1, "/api");
    const addPet = operations.find((op) => op.key === "addpet");
    if (!addPet) {
      throw new Error("addpet operation missing");
    }
    const page = operationMdx(specData(), addPet);
    expect(page.data.title).toBe("Add a pet");
    expect(page.data.sidebar).toStrictEqual({
      badge: "POST",
      label: "Add a pet",
    });
    expect(page.data.search).toStrictEqual({ tags: ["pet", "POST"] });
    expect(page.data.type).toBe("openapi-operation");
    // No description on this operation, so the body is just the component.
    expect(page.data).not.toHaveProperty("description");
    expect(page.body).toBe('<Operation source="api" id="addpet" />');
  });

  it("embeds an operation description as MDX-safe markdown in the body", () => {
    const op = {
      deprecated: false,
      description: "See [docs](https://x.dev) for {details} & <config>.",
      key: "op",
      method: "post" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    };
    const page = operationMdx(specData(), op);
    expect(page.body).toContain("[docs](https://x.dev)");
    // MDX-special characters are neutralized so the body still compiles.
    expect(page.body).toContain("&#123;details&#125;");
    expect(page.body).toContain("&lt;config&gt;");
    expect(
      page.body.trim().endsWith('<Operation source="api" id="op" />')
    ).toBe(true);
  });

  it("neutralizes description lines MDX would parse as ESM", () => {
    const op = {
      deprecated: false,
      description:
        "import the SDK and call the endpoint.\n\nexport of data requires auth.\n\nSupports exports and important flags.",
      key: "op",
      method: "post" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    };
    const page = operationMdx(specData(), op);
    // Lines starting with import/export would be parsed as ESM by acorn and
    // crash MDX compilation; the keyword's first letter is entity-escaped.
    expect(page.body).toContain("&#105;mport the SDK");
    expect(page.body).toContain("&#101;xport of data");
    // Mid-sentence and prefixed words are left alone.
    expect(page.body).toContain("Supports exports and important flags.");
  });

  it("skips a body description that only repeats the summary", () => {
    const op = {
      deprecated: false,
      description: "Add a pet",
      key: "op",
      method: "post" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Add a pet",
      tag: "x",
      tagSlug: "x",
    };
    const page = operationMdx(specData(), op);
    expect(page.body).toBe('<Operation source="api" id="op" />');
  });

  it("renders an overview page with the description as markdown in the body", () => {
    const page = overviewMdx(
      specData({ description: "See [docs](https://x.dev).", title: "Petstore" })
    );
    expect(page.data.title).toBe("Petstore");
    expect(page.data).not.toHaveProperty("description");
    expect(page.body).toContain("[docs](https://x.dev)");
    expect(page.body.trim().endsWith('<ApiOverview source="api" />')).toBe(
      true
    );
  });

  it("emits tag sections as markdown headings above the operation lists", () => {
    const { operations, tags } = extractOperations(SPEC_3_1, "/api");
    const page = overviewMdx(
      specData({
        operations: Object.fromEntries(
          operations.map((operation) => [operation.key, operation])
        ),
        tags,
      })
    );
    // A markdown `##` heading (not component markup) so it flows into the TOC.
    expect(page.body).toContain("## pet");
    expect(page.body).toContain('<ApiTagOperations source="api" tag="pet" />');
    // A declared tag no operation uses gets no section.
    const empty = overviewMdx(
      specData({ tags: [{ description: "", name: "unused", slug: "unused" }] })
    );
    expect(empty.body).not.toContain("## unused");
  });

  it("synthesizes a section for a tag an operation references but the spec never declares", () => {
    // The operation's tagSlug isn't in `spec.tags`, so overviewMdx must add the
    // section from the operation itself — using its display tag name.
    const op = {
      deprecated: false,
      description: "",
      key: "ping",
      method: "get" as const,
      operationId: "ping",
      path: "/ping",
      route: "/api/webhooks/ping",
      summary: "Ping",
      tag: "Webhooks",
      tagSlug: "webhooks",
    };
    const page = overviewMdx(specData({ operations: { ping: op } }));
    // The undeclared tag still gets a markdown heading + its operation list.
    expect(page.body).toContain("## Webhooks");
    expect(page.body).toContain(
      '<ApiTagOperations source="api" tag="webhooks" />'
    );
  });
});

describe("source.openApiSource", () => {
  it("emits one entry per operation plus an overview, and exposes parsed data", async () => {
    const dir = await tempSpec(SPEC_3_1);
    const reference = {
      display: { codeSamples: ["curl"], expandSchemas: false },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "spec.json",
    };
    const source = openApiSource([reference], ctx(dir));
    expect(isOpenApiSource(source)).toBe(true);

    const { entries, diagnostics } = await source.load();
    expect(diagnostics).toStrictEqual([]);
    // 3 operations + 1 overview index.
    expect(entries).toHaveLength(4);
    const refs = entries.map((entry) => entry.ref);
    expect(refs).toContain("api/pet/addpet.mdx");
    expect(refs.at(-1)).toBe("api/index.mdx");

    const data = source.openApiData();
    expect(data.api?.title).toBe("Petstore");
    expect(Object.keys(data.api?.operations ?? {})).toContain("addpet");
    await rm(dir, { force: true, recursive: true });
  });

  const missingReference = {
    display: { codeSamples: [], expandSchemas: false },
    kind: "openapi" as const,
    label: "API",
    renderer: "blume" as const,
    route: "/api",
    slug: "api",
    spec: "missing.json",
  };

  it("errors in build when a spec cannot be loaded (dead tab otherwise)", async () => {
    const source = openApiSource([missingReference], ctx("/no/such/root"));
    const { entries, diagnostics } = await source.load();
    expect(entries).toStrictEqual([]);
    expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_UNAVAILABLE");
    expect(diagnostics[0]?.severity).toBe("error");
    expect(source.openApiData()).toStrictEqual({});
  });

  it("degrades to a warning in dev so offline work still runs", async () => {
    const source = openApiSource([missingReference], {
      cacheDir: "/no/such/root/.blume/cache/openapi",
      mode: "dev",
      projectRoot: "/no/such/root",
    });
    const { diagnostics } = await source.load();
    expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_UNAVAILABLE");
    expect(diagnostics[0]?.severity).toBe("warning");
  });

  it("warns (BLUME_OPENAPI_STALE) when a remote spec is served from cache", async () => {
    const original = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), "blume-openapi-src-"));
    const reference = {
      display: { codeSamples: [], expandSchemas: false },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "https://api.test/openapi.json",
    };
    const sctx = {
      cacheDir,
      mode: "build" as const,
      projectRoot: "/",
      refresh: true,
    };
    try {
      // Prime the cache with a good fetch, then fail so the load falls back.
      globalThis.fetch = queued([
        Response.json({
          info: { title: "Remote", version: "1" },
          openapi: "3.0.0",
          paths: {},
        }),
      ]).fetch;
      const primed = await openApiSource([reference], sctx).load();
      expect(primed.diagnostics).toStrictEqual([]);

      globalThis.fetch = queued([new Response("gone", { status: 404 })]).fetch;
      const { diagnostics, entries } = await openApiSource(
        [reference],
        sctx
      ).load();
      expect(entries.length).toBeGreaterThan(0);
      expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_STALE");
      expect(diagnostics[0]?.severity).toBe("warning");
    } finally {
      globalThis.fetch = original;
      await rm(cacheDir, { force: true, recursive: true });
    }
  });
});

const schemas = (SPEC_3_1.components?.schemas ?? {}) as unknown as Record<
  string,
  SchemaLike
>;

describe("helpers", () => {
  it("resolves refs and names them", () => {
    expect(refName("#/components/schemas/Pet")).toBe("Pet");
    expect(
      resolveSchema(schemas, { $ref: "#/components/schemas/Pet" }).type
    ).toBe("object");
    expect(resolveSchema(schemas)).toStrictEqual({});
    // Unknown ref is returned as-is.
    expect(
      resolveSchema(schemas, { $ref: "#/components/schemas/Nope" })
    ).toStrictEqual({ $ref: "#/components/schemas/Nope" });
  });

  it("labels types across shapes", () => {
    expect(typeLabel({ $ref: "#/components/schemas/Pet" })).toBe("Pet");
    expect(typeLabel({ items: { type: "string" }, type: "array" })).toBe(
      "string[]"
    );
    expect(typeLabel({ oneOf: [{ type: "string" }, { type: "number" }] })).toBe(
      "string | number"
    );
    expect(typeLabel({ allOf: [{ type: "object" }] })).toBe("object");
    expect(typeLabel({ format: "int64", type: "integer" })).toBe(
      "integer<int64>"
    );
    expect(typeLabel({})).toBe("any");
  });

  it("detects nullability and lists constraints", () => {
    expect(isNullable({ nullable: true })).toBe(true);
    expect(isNullable({ type: ["string", "null"] })).toBe(true);
    expect(isNullable({ type: "string" })).toBe(false);
    expect(
      constraints({ default: 2, maximum: 10, minimum: 1, pattern: "^x$" })
    ).toStrictEqual(["min 1", "max 10", "matches ^x$", "default: 2"]);
  });

  it("merges allOf properties and their required set", () => {
    const merged = objectProperties(
      {
        allOf: [
          { properties: { a: { type: "string" } }, required: ["a"] },
          { properties: { b: { type: "number" } } },
        ],
      },
      schemas
    );
    expect(merged.properties.map(([name]) => name).toSorted()).toStrictEqual([
      "a",
      "b",
    ]);
    expect(merged.required.has("a")).toBe(true);
  });

  it("survives circular refs through array items and allOf chains", () => {
    const node: SchemaLike = {
      items: { $ref: "#/components/schemas/Node" },
      type: "array",
    };
    const cyclic: Record<string, SchemaLike> = {
      Chicken: { allOf: [{ $ref: "#/components/schemas/Egg" }] },
      Egg: {
        allOf: [{ $ref: "#/components/schemas/Chicken" }],
        properties: { id: { type: "string" } },
      },
      Node: node,
    };
    // Array-of-self labels by ref name instead of recursing forever.
    expect(typeLabel(node)).toBe("Node[]");
    expect(typeLabel({ $ref: "#/components/schemas/Node" })).toBe("Node");
    // Mutually-recursive allOf chains terminate and still merge fields.
    const merged = objectProperties(
      { $ref: "#/components/schemas/Chicken" },
      cyclic
    );
    expect(merged.properties.map(([name]) => name)).toStrictEqual(["id"]);
    expect(
      exampleValue({ $ref: "#/components/schemas/Chicken" }, cyclic)
    ).toStrictEqual({ id: "string" });
  });

  it("builds example values and guards circular refs", () => {
    const pet = exampleValue(
      { $ref: "#/components/schemas/Pet" },
      schemas
    ) as Record<string, unknown>;
    expect(pet.name).toBe("doggie");
    expect(pet.status).toBe("available");
    // Tag is self-referential; the guard stops it resolving forever.
    const tag = exampleValue(
      { $ref: "#/components/schemas/Tag" },
      schemas
    ) as Record<string, unknown>;
    expect(tag).toHaveProperty("name");
    expect(exampleValue({ type: "boolean" }, schemas)).toBe(true);
    expect(exampleValue({ format: "date-time", type: "string" }, schemas)).toBe(
      "2024-01-01T00:00:00Z"
    );
    expect(exampleValue({ examples: [42] }, schemas)).toBe(42);
    expect(exampleValue({ default: "d" }, schemas)).toBe("d");
    expect(exampleValue(undefined, schemas)).toBeNull();
    expect(toJson({ a: 1 })).toContain('"a": 1');
  });
});

describe("snippets", () => {
  it("builds a request sample and renders each language", () => {
    const operation = {
      parameters: [
        {
          example: 7,
          in: "path",
          name: "petId",
          schema: { type: "integer" },
        },
        {
          in: "query",
          name: "verbose",
          required: true,
          schema: { type: "boolean" },
        },
        {
          in: "header",
          name: "X-Key",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: { "application/json": { schema: { type: "object" } } },
      },
    };
    const sample = buildRequestSample(
      operation,
      "post",
      "/pet/{petId}",
      [{ url: "https://api.test/v1/" }],
      schemas
    );
    expect(sample.method).toBe("POST");
    expect(sample.url).toBe("https://api.test/v1/pet/7?verbose=true");
    expect(sample.headers["Content-Type"]).toBe("application/json");
    expect(sample.headers["X-Key"]).toBeDefined();

    const [curl, js, python] = sampleLanguages(["curl", "js", "python"]).map(
      (language) => language.build(sample)
    );
    expect(curl).toContain('curl -X POST "https://api.test/v1/pet/7');
    expect(js).toContain("await fetch(");
    expect(python).toContain("import requests");
  });

  it("keeps code samples correct on hostile example values", () => {
    const sample = {
      body: '{\n  "note": "it\'s true",\n  "active": true,\n  "tags": null\n}',
      bodyValue: { active: true, note: "it's true", tags: null },
      headers: {},
      method: "POST",
      url: "https://api.test/v1/pet",
    };
    const [curl, python] = sampleLanguages(["curl", "python"]).map((language) =>
      language.build(sample)
    );
    // The apostrophe must not terminate the shell's single-quoted -d value.
    expect(curl).toContain(String.raw`it'\''s true`);
    // Keyword rewriting applies outside JSON strings only — the *value*
    // "it's true" keeps its lowercase true.
    expect(python).toContain('"note": "it\'s true"');
    expect(python).toContain('"active": True');
    expect(python).toContain('"tags": None');
  });

  it("resolves language ids through aliases and drops unknowns", () => {
    const ids = sampleLanguages(["shell", "typescript", "nope"]).map(
      (language) => language.id
    );
    expect(ids).toStrictEqual(["curl", "js"]);
    // Empty falls back to the default trio.
    expect(sampleLanguages([]).map((language) => language.id)).toStrictEqual([
      "curl",
      "js",
      "python",
    ]);
  });
});
