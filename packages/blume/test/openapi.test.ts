import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";
import stringWidth from "string-width";

import {
  constraints,
  exampleValue,
  isNullable,
  mergeParameters,
  objectProperties,
  refName,
  resolveComponentRef,
  resolveSchema,
  toJson,
  typeLabel,
} from "../src/components/openapi/helpers.ts";
import type {
  ParameterLike,
  SchemaLike,
} from "../src/components/openapi/helpers.ts";
import { operationModel } from "../src/components/openapi/operation-model.ts";
import {
  buildRequest,
  defaultValues,
} from "../src/components/openapi/request.ts";
import { languageSamplePanels } from "../src/components/openapi/sample-panels.ts";
import {
  effectiveSecurity,
  resolveSecurity,
  schemeCarrier,
  schemeLabel,
} from "../src/components/openapi/security.ts";
import type { SecurityRequirementLike } from "../src/components/openapi/security.ts";
import { sampleLanguages } from "../src/components/openapi/snippets.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import type { NavNode, ProjectContext } from "../src/core/types.ts";
import {
  extractOperations,
  operationKey,
  operationObject,
} from "../src/openapi/model.ts";
import type { ApiDocument, ApiSpecData } from "../src/openapi/model.ts";
import { InvalidSpecError, parseSpec } from "../src/openapi/parse.ts";
import {
  blumeReferences,
  hasScalarReferences,
  resolveReferences,
} from "../src/openapi/references.ts";
import { operationMdx, overviewMdx } from "../src/openapi/render-mdx.ts";
import { buildReferenceFiles } from "../src/openapi/scalar.ts";
import { isOpenApiSource, openApiSource } from "../src/openapi/source.ts";

const ctx = (projectRoot: string) => ({
  cacheDir: join(projectRoot, ".blume/cache/openapi"),
  mode: "build" as const,
  projectRoot,
});

/**
 * The slice of an operation the path fixtures in this file exercise. Schemas
 * use `SchemaLike` because Blume keeps `$ref` nodes inline, which the scalar
 * `SchemaObject` union does not model.
 */
interface OperationFixture {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: ParameterLike[];
  requestBody?: {
    content?: Record<string, { schema?: SchemaLike }>;
    required?: boolean;
  };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: SchemaLike }>; description?: string }
  >;
}

/** A path item as fixtures declare it: real, or `null` for the malformed case. */
type PathItemFixture = {
  $ref?: string;
  get?: OperationFixture;
  post?: OperationFixture;
} | null;

/**
 * Widen a partial spec fixture into the parsed-document type. Fixtures stay
 * minimal — no `info`, sometimes a deliberately malformed path item — because
 * extractOperations must harden against exactly that input.
 */
const asDocument = (
  spec: Partial<Omit<ApiDocument, "components" | "paths">> & {
    /** Component schemas as Blume renders them: `$ref` nodes kept inline. */
    components?: { schemas?: Record<string, SchemaLike> };
    paths?: Record<string, PathItemFixture>;
  }
): ApiDocument =>
  // SAFETY: every Document field a fixture omits is optional at runtime, and
  // the malformed entries (null path items) are the hardening cases under test.
  spec as ApiDocument;

const SPEC_SCHEMAS = {
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
} satisfies Record<string, SchemaLike>;

const SPEC_3_1 = asDocument({
  components: { schemas: SPEC_SCHEMAS },
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
});

/** Spec-file contents to write to disk: a 3.x fixture or a legacy 2.0 one. */
const tempSpec = async (
  contents: Partial<ApiDocument> & { swagger?: string }
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-openapi-"));
  const file = join(dir, "spec.json");
  await writeFile(file, JSON.stringify(contents));
  return dir;
};

/**
 * Wrap a request handler as a full `fetch`: Bun's `fetch` also carries a
 * `preconnect` helper, so the stub borrows the real one (never called here).
 */
const asFetch = (
  handler: (
    input: string | URL | Request,
    init?: RequestInit
  ) => Promise<Response>
): typeof fetch => Object.assign(handler, { preconnect: fetch.preconnect });

/** A `fetch` stub that always resolves to the given response. */
const respondWith = (response: Response): typeof fetch =>
  asFetch(() => Promise.resolve(response));

// A `fetch` stub that yields queued responses (repeating the last), and records
// how many times it was called plus the last init it received.
const queued = (responses: Response[]) => {
  let count = 0;
  let lastInit: RequestInit | undefined;
  const stub = asFetch((_url, init) => {
    lastInit = init;
    const response = responses[Math.min(count, responses.length - 1)];
    count += 1;
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error("queued() needs at least one response"));
  });
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
      playground: { enabled: true, proxy: false },
    });
    expect(hasScalarReferences(config)).toBe(false);
    expect(blumeReferences(config)).toHaveLength(1);
  });

  it("resolves a Blume-rendered AsyncAPI reference by default", () => {
    const config = blumeConfigSchema.parse({
      asyncapi: { enabled: true, spec: "async.yaml" },
    });
    const refs = resolveReferences(config);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.renderer).toBe("blume");
    expect(refs[0]?.kind).toBe("asyncapi");
    expect(refs[0]?.slug).toBe("events");
    expect(refs[0]?.display).toStrictEqual({
      codeSamples: [],
      expandSchemas: false,
      playground: { enabled: true, proxy: false },
    });
    expect(hasScalarReferences(config)).toBe(false);
    expect(blumeReferences(config)).toHaveLength(1);
  });

  it("keeps the Scalar opt-out for AsyncAPI", () => {
    const config = blumeConfigSchema.parse({
      asyncapi: { enabled: true, renderer: "scalar", spec: "async.yaml" },
    });
    expect(hasScalarReferences(config)).toBe(true);
    expect(blumeReferences(config)).toStrictEqual([]);
    expect(resolveReferences(config)[0]?.renderer).toBe("scalar");
  });

  it("carries a scalar passthrough block onto its references", () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        scalar: {
          agent: { disabled: true },
          hideTestRequestButton: true,
          localization: { locale: "es" },
          orderSchemaPropertiesBy: "preserve",
        },
        spec: "https://example.com/spec.json",
      },
    });
    expect(resolveReferences(config)[0]?.scalar).toStrictEqual({
      agent: { disabled: true },
      hideTestRequestButton: true,
      localization: { locale: "es" },
      orderSchemaPropertiesBy: "preserve",
    });
  });

  it("carries per-source search, LLM, and crawler controls", () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        sources: [
          {
            includeInLlms: false,
            includeInSearch: false,
            noindex: true,
            spec: "platform.json",
          },
        ],
      },
    });
    expect(resolveReferences(config)[0]).toMatchObject({
      includeInLlms: false,
      includeInSearch: false,
      noindex: true,
    });
  });

  it("forwards scalar options into the generated page, winning over theme", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        // A remote spec avoids file IO; the config is inlined verbatim.
        scalar: { localization: { locale: "es" }, theme: "moon" },
        spec: "https://example.com/spec.json",
        theme: "purple",
      },
    });
    const { files } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/tmp",
    });
    expect(files).toHaveLength(1);
    const { content } = files[0] ?? { content: "" };
    expect(content).toContain('"locale": "es"');
    // The scalar block's theme wins over the dedicated `theme` field.
    expect(content).toContain('"theme": "moon"');
    expect(content).not.toContain('"theme": "purple"');
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
    const refs = blumeReferences(config);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.spec).toBe("a.json");
    // The dropped source is recorded on the kept reference so the load can
    // warn — losing a whole spec's pages must not be silent.
    expect(refs[0]?.collisions).toStrictEqual([
      "Two API reference sources resolve to /api; keeping the first.",
    ]);
  });

  it("disambiguates slugs when distinct routes slugify identically", () => {
    // `/api/v1` and `/api-v1` both slugify to `api-v1`; the slug keys the
    // `blume:openapi` data module, so a collision would clobber one spec.
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        sources: [
          { route: "/api/v1", spec: "a.json" },
          { route: "/api-v1", spec: "b.json" },
        ],
      },
    });
    const refs = blumeReferences(config);
    expect(refs.map((ref) => ref.slug)).toStrictEqual(["api-v1", "api-v1-2"]);
  });

  it("carries the site-wide basePath onto every resolved reference", () => {
    const config = blumeConfigSchema.parse({
      basePath: "/docs",
      openapi: { enabled: true, spec: "spec.json" },
    });
    const [ref] = resolveReferences(config);
    expect(ref?.basePath).toBe("/docs");
    // The route itself stays base-less: the content pipeline mounts the staged
    // pages under `basePath`, so only emitted URLs get the prefix.
    expect(ref?.route).toBe("/reference");
  });

  it("appends a staged openapi source when a Blume reference is configured", () => {
    const config = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "spec.json" },
    });
    // SAFETY: resolveSources only reads `root`, `contentRoot`, and `outDir`
    // from the context; the other ProjectContext paths are never touched.
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
    const { operations, tags, warnings } = extractOperations(SPEC_3_1, "/api");
    const byKey = new Map(operations.map((op) => [op.key, op]));
    expect(operations).toHaveLength(3);
    expect(warnings).toStrictEqual([]);
    expect(byKey.get("addpet")?.route).toBe("/api/pet/addpet");
    expect(byKey.get("addpet")?.method).toBe("post");
    expect(tags.map((tag) => tag.slug)).toContain("pet");
    // Untagged operation falls back to the "Operations" group.
    const ping = operations.find((op) => op.path === "/ping");
    expect(ping?.tag).toBe("Operations");
    expect(ping?.route).toBe("/api/operations/get-ping");
  });

  it("mounts a root reference without a double slash", () => {
    const { operations } = extractOperations(SPEC_3_1, "/");
    for (const operation of operations) {
      expect(operation.route.startsWith("//")).toBe(false);
    }
    const addPet = operations.find((op) => op.key === "addpet");
    expect(addPet?.route).toBe("/pet/addpet");
  });

  it("warns on a $ref path item instead of silently dropping it", () => {
    const { operations, warnings } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: {
          "/gone": null,
          "/pets": { $ref: "#/components/pathItems/pets" },
          "/x": { get: { operationId: "x" } },
        },
      }),
      "/api"
    );
    // The empty item is skipped silently; only the $ref one is reported.
    expect(operations.map((op) => op.key)).toStrictEqual(["x"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"/pets"');
  });

  it("derives an operation key from method+path when operationId is absent", () => {
    expect(operationKey("get", "/pets/{id}")).toBe("get-pets-id");
    expect(operationKey("get", "/pets", "listPets")).toBe("listpets");
  });

  it("de-duplicates a repeated operationId across operations", () => {
    const { operations } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: {
          "/a": { get: { operationId: "dup" } },
          "/b": { post: { operationId: "dup" } },
        },
      }),
      "/api"
    );
    const keys = operations.map((op) => op.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("dup");
  });

  it("carries tag descriptions from the document's top-level tags", () => {
    const { tags } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: { "/x": { get: { operationId: "x", tags: ["pet"] } } },
        tags: [{ description: "Pet ops", name: "pet" }],
      }),
      "/api"
    );
    expect(tags).toStrictEqual([
      { description: "Pet ops", name: "pet", slug: "pet" },
    ]);
  });

  it("keeps distinct non-Latin tags on distinct letter-preserving slugs", () => {
    const { operations, tags } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: {
          "/orders": { get: { operationId: "listOrders", tags: ["注文"] } },
          "/pets": { get: { operationId: "listPets", tags: ["ペット"] } },
          "/pets/{petId}": { get: { operationId: "getPet", tags: ["ペット"] } },
        },
      }),
      "/api"
    );
    const byKey = new Map(operations.map((op) => [op.key, op]));
    expect(byKey.get("listorders")?.tagSlug).toBe("注文");
    expect(byKey.get("listpets")?.tagSlug).toBe("ペット");
    expect(byKey.get("listorders")?.route).toBe("/api/注文/listorders");
    expect(byKey.get("listpets")?.route).toBe("/api/ペット/listpets");
    expect(byKey.get("getpet")?.tagSlug).toBe("ペット");
    expect(
      tags.map((tag) => ({ name: tag.name, slug: tag.slug }))
    ).toStrictEqual([
      { name: "注文", slug: "注文" },
      { name: "ペット", slug: "ペット" },
    ]);
  });

  it("keeps diacritics in tag slugs so nav labels stay one word", () => {
    const nfdNinos = "Nin\u0303os";
    const { operations, tags } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: {
          "/children": {
            get: {
              operationId: "listChildren",
              tags: ["Niños"],
            },
          },
          "/nfd-children": {
            get: {
              operationId: "listNfdChildren",
              tags: [nfdNinos],
            },
          },
          "/sizes": {
            get: {
              operationId: "listSizes",
              tags: ["Größe"],
            },
          },
        },
      }),
      "/api"
    );
    const byKey = new Map(operations.map((op) => [op.key, op]));
    expect(byKey.get("listchildren")?.tagSlug).toBe("niños");
    // The NFD spelling normalizes onto the same slug as the NFC tag; the two
    // are still distinct tag *names*, so the collision suffix keeps their
    // routes apart visibly instead of minting a byte-distinct, pixel-identical
    // twin slug.
    expect(byKey.get("listnfdchildren")?.tagSlug).toBe("niños-2");
    expect(byKey.get("listsizes")?.tagSlug).toBe("größe");
    expect(
      tags.map((tag) => ({ name: tag.name, slug: tag.slug }))
    ).toStrictEqual([
      { name: "Niños", slug: "niños" },
      { name: nfdNinos, slug: "niños-2" },
      { name: "Größe", slug: "größe" },
    ]);
  });

  it("drops format characters instead of splitting on them", () => {
    // ZWNJ (U+200C) is orthographically mandatory inside Persian compounds;
    // turning it into a hyphen re-creates the word-splitting bug this slug
    // policy exists to fix (the humanizer splits on hyphens).
    const { operations, tags } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: {
          "/apps": {
            get: { operationId: "listApps", tags: ["نرم‌افزار"] },
          },
        },
      }),
      "/api"
    );
    expect(operations[0]?.tagSlug).toBe("نرمافزار");
    expect(tags[0]?.slug).toBe("نرمافزار");
  });

  it("falls back when a tag is only combining marks", () => {
    // A bare combining mark is truthy but has no base letter — without the
    // leading-mark trim it would bypass the `operations` fallback and mint an
    // invisible route segment that glues onto the preceding `/` in URLs.
    const { operations, tags } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: {
          "/a": { get: { operationId: "a", tags: ["̃"] } },
        },
      }),
      "/api"
    );
    expect(operations[0]?.tagSlug).toBe("operations");
    expect(tags[0]?.slug).toBe("operations");
  });

  it("falls back when a tag has no letters or numbers", () => {
    const { operations, tags } = extractOperations(
      asDocument({
        openapi: "3.1.0",
        paths: {
          "/a": { get: { operationId: "a", tags: ["!!!"] } },
          "/b": { get: { operationId: "b", tags: ["???"] } },
        },
      }),
      "/api"
    );
    const byKey = new Map(operations.map((op) => [op.key, op]));
    expect(byKey.get("a")?.tagSlug).toBe("operations");
    expect(byKey.get("b")?.tagSlug).toBe("operations-2");
    expect(
      tags.map((tag) => ({ name: tag.name, slug: tag.slug }))
    ).toStrictEqual([
      { name: "!!!", slug: "operations" },
      { name: "???", slug: "operations-2" },
    ]);
  });

  it("resolves an operation object out of its spec document", () => {
    const { operations } = extractOperations(SPEC_3_1, "/api");
    // SAFETY: operationObject only reads `spec.document`; the other
    // ApiSpecData fields never matter to this lookup.
    const spec = { document: SPEC_3_1 } as ApiSpecData;
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

  it("rejects a readable file that isn't an OpenAPI document", async () => {
    // Empty file, YAML scalar, and YAML list all normalize to a null
    // specification; without the guard they crash later with a raw TypeError.
    const dir = await mkdtemp(join(tmpdir(), "blume-openapi-"));
    await writeFile(join(dir, "empty.yaml"), "");
    await writeFile(join(dir, "scalar.yaml"), "just some prose\n");
    await writeFile(join(dir, "list.yaml"), "- a\n- b\n");
    for (const file of ["empty.yaml", "scalar.yaml", "list.yaml"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      await expect(parseSpec(file, dir)).rejects.toThrow(InvalidSpecError);
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      await expect(parseSpec(file, dir)).rejects.toThrow(
        /is not a valid OpenAPI document/u
      );
    }
    await rm(dir, { force: true, recursive: true });
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
      expect(new Headers(stub.lastInit?.headers).get("user-agent")).toContain(
        "blume"
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("honors a sane Retry-After on a rate-limited response", async () => {
    const original = globalThis.fetch;
    const stub = queued([
      new Response("slow down", {
        headers: { "retry-after": "1" },
        status: 429,
      }),
      Response.json(remoteSpec),
    ]);
    globalThis.fetch = stub.fetch;
    const started = performance.now();
    try {
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/"
      );
      expect(document.info?.title).toBe("Remote");
      expect(stub.calls).toBe(2);
      // The server's 1s wait replaces the 500ms base backoff (it does not
      // stack on top of it, which would be ~1.5s).
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(950);
      expect(waited).toBeLessThan(1450);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("honors the HTTP-date form of Retry-After", async () => {
    const original = globalThis.fetch;
    const stub = queued([
      new Response("slow down", {
        // RFC 9110's other spelling: an absolute date instead of seconds.
        headers: { "retry-after": new Date(Date.now() + 1000).toUTCString() },
        status: 429,
      }),
      Response.json(remoteSpec),
    ]);
    globalThis.fetch = stub.fetch;
    const started = performance.now();
    try {
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/"
      );
      expect(document.info?.title).toBe("Remote");
      expect(stub.calls).toBe(2);
      // toUTCString truncates to whole seconds, so allow up to a second of
      // slack below the nominal 1s wait.
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(450);
      expect(waited).toBeLessThan(1450);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("ignores an unparseable Retry-After and backs off normally", async () => {
    const original = globalThis.fetch;
    const stub = queued([
      new Response("slow down", {
        headers: { "retry-after": "soonish" },
        status: 429,
      }),
      Response.json(remoteSpec),
    ]);
    globalThis.fetch = stub.fetch;
    const started = performance.now();
    try {
      const { document } = await parseSpec(
        "https://api.test/openapi.json",
        "/"
      );
      expect(document.info?.title).toBe("Remote");
      expect(stub.calls).toBe(2);
      // No usable header: only p-retry's 500ms base backoff applies.
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(450);
      expect(waited).toBeLessThan(950);
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
    globalThis.fetch = asFetch(() => {
      calls += 1;
      return Promise.reject(new Error("ECONNRESET"));
    });
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

  it("throws when the fetch fails and no cached copy exists", async () => {
    const original = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), "blume-openapi-cache-"));
    globalThis.fetch = queued([new Response("gone", { status: 404 })]).fetch;
    try {
      await expect(
        parseSpec("https://api.test/openapi.json", "/", {
          cacheDir,
          refresh: true,
        })
      ).rejects.toThrow(/404/u);
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
    // SAFETY: render-mdx never reads `kind` — the only ApiSpecData field these
    // defaults omit.
    ({
      codeSamples: [],
      description: "",
      document: SPEC_3_1,
      expandSchemas: false,
      label: "API",
      operations: {},
      playground: { enabled: true, proxy: false },
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

  it("applies a reference source's indexing controls to every generated page", () => {
    const { operations } = extractOperations(SPEC_3_1, "/api");
    const addPet = operations.find((op) => op.key === "addpet");
    if (!addPet) {
      throw new Error("addpet operation missing");
    }
    const reference = {
      includeInLlms: false,
      includeInSearch: false,
      noindex: true,
    };
    const operation = operationMdx(specData(), addPet, reference);
    const overview = overviewMdx(specData(), reference);
    for (const page of [operation, overview]) {
      expect(page.data.ai).toStrictEqual({ exclude: true });
      expect(page.data.search).toMatchObject({ exclude: true });
      expect(page.data.seo).toMatchObject({ noindex: true });
    }
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
    // MDX-special characters are neutralized so the body still compiles. `>`
    // stays raw — it isn't MDX-special on its own, and escaping it would turn
    // `> Note:` blockquotes into literal "&gt; Note:" text.
    expect(page.body).toContain("&#123;details&#125;");
    expect(page.body).toContain("&lt;config>");
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

  it("leaves backtick code verbatim while escaping surrounding prose", () => {
    const op = {
      deprecated: false,
      description: [
        "Fetch a pet via `/pets/{petId}` with {retries} allowed:",
        "",
        "```json",
        '{"name": "doggie"}',
        "```",
        "",
        "import statements in prose are still escaped.",
      ].join("\n"),
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    };
    const page = operationMdx(specData(), op);
    // Code spans and fences are literal in MDX and entities are not decoded
    // inside them — they must pass through untouched.
    expect(page.body).toContain("`/pets/{petId}`");
    expect(page.body).toContain('{"name": "doggie"}');
    // Prose around the code is still neutralized.
    expect(page.body).toContain("&#123;retries&#125;");
    expect(page.body).toContain("&#105;mport statements");
  });

  it("does not let an unmatched inline backtick swallow a following fence", () => {
    const op = {
      deprecated: false,
      description: [
        "One stray ` backtick, then {braces} in prose:",
        "",
        "```json",
        '{"petId": 1}',
        "```",
      ].join("\n"),
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    };
    const page = operationMdx(specData(), op);
    // A lone backtick has no equal-length closer, so it must not pair with the
    // first backtick of the fence run — the prose braces stay escaped and the
    // fence body stays verbatim, with no entities leaking into it.
    expect(page.body).toContain(
      "One stray ` backtick, then &#123;braces&#125;"
    );
    expect(page.body).toContain('```json\n{"petId": 1}\n```');
    expect(page.body).not.toContain('&#123;"petId"');
  });

  it("leaves a tilde fence verbatim while escaping surrounding prose", () => {
    const op = {
      deprecated: false,
      description: [
        "Response shape with {inline} braces:",
        "",
        "~~~json",
        '{"name": "doggie"}',
        "~~~~",
        "",
        "More {prose} after.",
      ].join("\n"),
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    };
    const page = operationMdx(specData(), op);
    // Tilde fences are code in MDX like backtick fences; the body must pass
    // through untouched (a longer closing run still closes per CommonMark).
    expect(page.body).toContain('~~~json\n{"name": "doggie"}\n~~~~');
    expect(page.body).toContain("&#123;inline&#125;");
    expect(page.body).toContain("More &#123;prose&#125; after.");
  });

  it("escapes braces in indented blocks, which MDX has no code form for", () => {
    const page = operationMdx(specData(), {
      deprecated: false,
      // CommonMark would call the indented line a code block, but MDX
      // disables indented code — it compiles as a paragraph, so its braces
      // must be escaped like any other prose.
      description: 'Sample:\n\n    {"indented": true}\n\nAfter {prose}.',
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    });
    expect(page.body).toContain('&#123;"indented": true&#125;');
    expect(page.body).toContain("After &#123;prose&#125;.");
  });

  it("treats an unclosed tilde fence as running to the end of the text", () => {
    const page = operationMdx(specData(), {
      deprecated: false,
      description: 'Before {braces}.\n\n~~~\n{"open": true}',
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    });
    expect(page.body).toContain("Before &#123;braces&#125;.");
    expect(page.body).toContain('~~~\n{"open": true}');
    expect(page.body).not.toContain('&#123;"open"');
  });

  it("keeps a double-backtick span verbatim and escapes an unbalanced run", () => {
    const balanced = operationMdx(specData(), {
      deprecated: false,
      description: "Span `a``b` with {braces}.",
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    });
    // A single-backtick span may contain a longer backtick run — it closes on
    // the next equal-length (single) run and passes through untouched.
    expect(balanced.body).toContain("`a``b`");
    expect(balanced.body).toContain("&#123;braces&#125;");

    const unbalanced = operationMdx(specData(), {
      deprecated: false,
      description: "Broken ``x` run and {braces} after.",
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    });
    // Double backticks with only a single-backtick "closer" form no span, so
    // the whole line is prose and its braces are escaped.
    expect(unbalanced.body).toContain("``x`");
    expect(unbalanced.body).toContain("&#123;braces&#125;");
  });

  it("leaves a blockquote note in a description un-escaped", () => {
    const op = {
      deprecated: false,
      description: "Heads up:\n\n> **Note:** Braces {inside} a note.\n\nDone.",
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/x",
      route: "/api/x/op",
      summary: "Do a thing",
      tag: "x",
      tagSlug: "x",
    };
    const page = operationMdx(specData(), op);
    // `>` isn't MDX-special on its own; escaping it would turn the blockquote
    // into literal "&gt; **Note:**" text.
    expect(page.body).toContain(
      "> **Note:** Braces &#123;inside&#125; a note."
    );
    expect(page.body).not.toContain("&gt;");
  });

  it("gives every operation a distinct meta description", () => {
    const op = {
      deprecated: false,
      description: "",
      key: "op",
      method: "delete" as const,
      operationId: "op",
      path: "/pet/{petId}",
      route: "/api/pet/op",
      summary: "Deletes a pet",
      tag: "pet",
      tagSlug: "pet",
    };
    const page = operationMdx(specData({ title: "Petstore" }), op);
    // Without this the page sets no description and inherits the site-wide one,
    // so every operation in the spec ships the same meta description. It lives
    // under `seo` so it feeds the meta tag without also printing as a subtitle.
    expect(page.data.seo).toStrictEqual({
      description:
        "Deletes a pet Reference for the DELETE /pet/{petId} endpoint in the Petstore API.",
    });
    expect(page.data).not.toHaveProperty("description");
  });

  it("flattens markdown prose into the meta description and caps its length", () => {
    const op = {
      deprecated: false,
      description: `Fetch **every** pet from [the store](https://x.dev), ${"paginated ".repeat(30)}.\n\nA second paragraph is dropped.`,
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/pet",
      route: "/api/pet/op",
      summary: "List pets",
      tag: "pet",
      tagSlug: "pet",
    };
    // SAFETY: operationMdx always writes `seo.description` for an operation
    // with a summary, which the fixture above declares.
    const { description } = operationMdx(specData(), op).data.seo as {
      description: string;
    };
    expect(description.length).toBeLessThanOrEqual(160);
    // Markdown formatting is stripped — a meta description is plain text.
    expect(description).toContain("Fetch every pet from the store");
    expect(description).not.toContain("**");
    expect(description).not.toContain("](");
    expect(description).not.toContain("second paragraph");
    // Truncation cuts on a word boundary, never mid-word.
    expect(description).toContain("…");
  });

  it("caps a fullwidth meta description by display columns", () => {
    // 100 fullwidth characters are within the 160-character cap but render
    // ~200 columns wide — the audit, which grades in display columns, would
    // flag every generated operation page as "too long" with no fix short of
    // editing the upstream spec. The clip must budget in the same columns.
    const op = {
      deprecated: false,
      description: "あ".repeat(100),
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/pet",
      route: "/api/pet/op",
      summary: "List pets",
      tag: "pet",
      tagSlug: "pet",
    };
    // SAFETY: operationMdx always writes `seo.description` for an operation
    // with a summary, which the fixture above declares.
    const { description } = operationMdx(specData(), op).data.seo as {
      description: string;
    };
    expect(stringWidth(description)).toBeLessThanOrEqual(160);
    expect(description).toContain("…");
    expect(description).toEndWith("API.");
  });

  it("keeps literal punctuation intact in the meta description", () => {
    // The old regex strip deleted every *_`#> character, mangling prose that
    // legitimately contains them: snake_case → snakecase, C# → C.
    const op = {
      deprecated: false,
      description:
        "Filter by `user_id` or a C# client. Sorts use snake_case keys.",
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: "/pets",
      route: "/api/pets/op",
      summary: "List pets",
      tag: "pet",
      tagSlug: "pet",
    };
    // SAFETY: operationMdx always writes `seo.description` for an operation
    // with a summary, which the fixture above declares.
    const { description } = operationMdx(specData(), op).data.seo as {
      description: string;
    };
    expect(description).toContain("user_id");
    expect(description).toContain("C# client");
    expect(description).toContain("snake_case keys");
  });

  it("falls back to the API name when a long endpoint leaves no room for prose", () => {
    const op = {
      deprecated: false,
      description: "Ping",
      key: "op",
      method: "get" as const,
      operationId: "op",
      path: `/${"very-long-segment/".repeat(8)}`,
      route: "/api/x/op",
      summary: "Ping",
      tag: "x",
      tagSlug: "x",
    };
    // SAFETY: operationMdx always writes `seo.description` for an operation
    // with a summary, which the fixture above declares.
    const { description } = operationMdx(specData(), op).data.seo as {
      description: string;
    };
    // The endpoint sentence alone overruns the cap, so the prose budget is zero
    // and the description is the clipped sentence — never an empty string. The
    // path is one long token, so it is hard-cut rather than dropped whole.
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.startsWith("Reference for the GET /very-long")).toBe(
      true
    );
    expect(description.endsWith("…")).toBe(true);
  });

  it("describes the overview page with the spec description, then the API name", () => {
    const described = overviewMdx(
      specData({ description: "The **Petstore** API.", title: "Petstore" })
    );
    expect(described.data.seo).toStrictEqual({
      description: "The Petstore API.",
    });
    // A spec with no description still gets something better than the
    // site-wide default, which every other page already uses.
    const bare = overviewMdx(specData({ title: "Petstore" }));
    expect(bare.data.seo).toStrictEqual({
      description: "Petstore API reference.",
    });
  });

  it("renders one overview section per tag slug, not per tag name", () => {
    const document = asDocument({
      info: { title: "API", version: "1" },
      openapi: "3.1.0",
      paths: {
        "/order": { post: { operationId: "addOrder", tags: ["store"] } },
        "/store": { get: { operationId: "getStore", tags: ["Store"] } },
      },
      tags: [
        { description: "", name: "Store" },
        { description: "", name: "store" },
      ],
    });
    const { operations, tags } = extractOperations(document, "/api");
    const page = overviewMdx(
      specData({
        operations: Object.fromEntries(operations.map((op) => [op.key, op])),
        tags,
      })
    );
    // `Store` and `store` share the slug `store`; a section per NAME would
    // list every store operation twice.
    const sections = page.body.match(/tag="store"/gu) ?? [];
    expect(sections).toHaveLength(1);
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
  const indexedReference = {
    includeInLlms: true,
    includeInSearch: true,
    noindex: false,
  } as const;

  it("emits one entry per operation plus an overview, and exposes parsed data", async () => {
    const dir = await tempSpec(SPEC_3_1);
    const reference = {
      ...indexedReference,
      basePath: "",
      display: {
        codeSamples: ["curl"],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
      },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "spec.json",
    };
    const source = openApiSource([reference], ctx(dir));
    expect(isOpenApiSource(source)).toBe(true);

    const { entries, diagnostics, folderMeta } = await source.load();
    expect(diagnostics).toStrictEqual([]);
    // 3 operations + 1 overview index.
    expect(entries).toHaveLength(4);
    const refs = entries.map((entry) => entry.ref);
    expect(refs).toContain("api/pet/addpet.mdx");
    expect(refs.at(-1)).toBe("api/index.mdx");
    // Each tag directory is labeled with the spec's own tag name, so the
    // sidebar group renders the authored casing instead of a re-humanized slug.
    expect(folderMeta).toStrictEqual({
      "api/operations": { title: "Operations" },
      "api/pet": { title: "pet" },
    });

    const data = source.openApiData();
    expect(data.api?.title).toBe("Petstore");
    expect(Object.keys(data.api?.operations ?? {})).toContain("addpet");
    await rm(dir, { force: true, recursive: true });
  });

  it("serializes operation routes under basePath while entries stay base-less", async () => {
    const dir = await tempSpec(SPEC_3_1);
    const reference = {
      ...indexedReference,
      basePath: "/docs",
      display: {
        codeSamples: [],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
      },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "spec.json",
    };
    const source = openApiSource([reference], ctx(dir));
    const { entries } = await source.load();
    // The content pipeline mounts staged entries under `basePath` itself, so
    // the refs stay base-less...
    expect(entries.map((entry) => entry.ref)).toContain("api/pet/addpet.mdx");
    // ...but the routes components link to carry it, matching the served URLs.
    expect(source.openApiData().api?.operations.addpet?.route).toBe(
      "/docs/api/pet/addpet"
    );
    await rm(dir, { force: true, recursive: true });
  });

  it("surfaces a warning diagnostic for a $ref path item", async () => {
    const dir = await tempSpec({
      info: { title: "Refs", version: "1" },
      openapi: "3.1.0",
      paths: { "/pets": { $ref: "#/components/pathItems/pets" } },
    });
    const reference = {
      ...indexedReference,
      basePath: "",
      display: {
        codeSamples: [],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
      },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "spec.json",
    };
    const { diagnostics } = await openApiSource([reference], ctx(dir)).load();
    expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_REF_PATH_ITEM");
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.message).toContain('"/pets"');
    expect(diagnostics[0]?.message).toContain("spec.json");
    await rm(dir, { force: true, recursive: true });
  });

  it("warns when a parsed spec yields zero operations (empty reference)", async () => {
    // A document with no `paths` (a config file that parses as YAML, say)
    // builds successfully — but the reference tab would be silently empty.
    const dir = await tempSpec({
      info: { title: "Empty", version: "1" },
      openapi: "3.1.0",
      paths: {},
    });
    const reference = {
      ...indexedReference,
      basePath: "",
      display: {
        codeSamples: [],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
      },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "spec.json",
    };
    const { diagnostics, entries } = await openApiSource(
      [reference],
      ctx(dir)
    ).load();
    // The overview page still renders; only the operations are missing.
    expect(entries.map((entry) => entry.ref)).toStrictEqual(["api/index.mdx"]);
    expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_EMPTY");
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.message).toContain('"spec.json"');
    expect(diagnostics[0]?.message).toContain("/api");
    await rm(dir, { force: true, recursive: true });
  });

  it("suggests fixing the document (not reachability) for an invalid spec file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-openapi-src-"));
    await writeFile(join(dir, "README.md"), "# Not a spec\n");
    const reference = {
      ...indexedReference,
      basePath: "",
      display: {
        codeSamples: [],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
      },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "README.md",
    };
    const { diagnostics } = await openApiSource([reference], ctx(dir)).load();
    expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_UNAVAILABLE");
    expect(diagnostics[0]?.message).toContain(
      "is not a valid OpenAPI document"
    );
    expect(diagnostics[0]?.suggestion).toContain("Point the spec at");
    expect(diagnostics[0]?.suggestion).not.toContain("reachable");
    await rm(dir, { force: true, recursive: true });
  });

  it("surfaces recorded route collisions as warning diagnostics", async () => {
    const dir = await tempSpec(SPEC_3_1);
    const reference = {
      ...indexedReference,
      basePath: "",
      collisions: [
        "Two API reference sources resolve to /api; keeping the first.",
      ],
      display: {
        codeSamples: [],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
      },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "spec.json",
    };
    const { diagnostics } = await openApiSource([reference], ctx(dir)).load();
    expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_ROUTE_COLLISION");
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.message).toBe(
      "Two API reference sources resolve to /api; keeping the first."
    );
    await rm(dir, { force: true, recursive: true });
  });

  const missingReference = {
    ...indexedReference,
    basePath: "",
    display: {
      codeSamples: [],
      expandSchemas: false,
      playground: { enabled: true, proxy: false },
    },
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
      ...indexedReference,
      basePath: "",
      display: {
        codeSamples: [],
        expandSchemas: false,
        playground: { enabled: true, proxy: false },
      },
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
          paths: { "/ping": { get: { responses: { "200": {} } } } },
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

  it("labels tag sidebar groups with the spec's own tag name", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-nav-"));
    try {
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(
        join(root, "blume.config.ts"),
        'export default {\n  openapi: { enabled: true, route: "/api", spec: "./openapi.json" },\n};\n'
      );
      await writeFile(join(root, "docs/index.md"), "# Home\n");
      await writeFile(
        join(root, "openapi.json"),
        JSON.stringify({
          info: { title: "API", version: "1" },
          openapi: "3.1.0",
          paths: {
            "/token": {
              post: {
                operationId: "createToken",
                summary: "Create token",
                tags: ["OAuth2"],
              },
            },
          },
        })
      );
      const project = await scanProject(root);
      const labels: string[] = [];
      const walk = (nodes: NavNode[]): void => {
        for (const node of nodes) {
          if (node.kind === "group") {
            labels.push(node.label);
            walk(node.children);
          }
        }
      };
      walk(project.graph.navigation.sidebar);
      // The group label is the tag name the spec authored, not a re-humanized
      // slug ("Oauth2").
      expect(labels).toContain("OAuth2");
      expect(labels).not.toContain("Oauth2");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

const schemas = SPEC_SCHEMAS;

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
    const cyclic = {
      Chicken: { allOf: [{ $ref: "#/components/schemas/Egg" }] },
      Egg: {
        allOf: [{ $ref: "#/components/schemas/Chicken" }],
        properties: { id: { type: "string" } },
      },
      Node: node,
    } satisfies Record<string, SchemaLike>;
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
    const pet = exampleValue({ $ref: "#/components/schemas/Pet" }, schemas);
    expect(pet).toMatchObject({ name: "doggie", status: "available" });
    // Tag is self-referential; the guard stops it resolving forever.
    const tag = exampleValue({ $ref: "#/components/schemas/Tag" }, schemas);
    expect(tag).toHaveProperty("name");
    expect(exampleValue({ type: "boolean" }, schemas)).toBe(true);
    expect(exampleValue({ format: "date-time", type: "string" }, schemas)).toBe(
      "2019-08-24T14:15:22Z"
    );
    expect(exampleValue({ examples: [42] }, schemas)).toBe(42);
    expect(exampleValue({ default: "d" }, schemas)).toBe("d");
    expect(exampleValue(undefined, schemas)).toBeNull();
    // An unresolvable $ref makes the sampler throw; the sample is best-effort.
    expect(
      exampleValue({ $ref: "#/components/schemas/Missing" }, {})
    ).toBeNull();
    expect(toJson({ a: 1 })).toContain('"a": 1');
  });

  it("honors const in example values (the 3.1 discriminator idiom)", () => {
    expect(exampleValue({ const: "dog", type: "string" }, schemas)).toBe("dog");
    // const is the only valid value, so it outranks default and enum...
    expect(
      exampleValue({ const: "dog", default: "cat", enum: ["cat"] }, schemas)
    ).toBe("dog");
    // ...but a declared example still wins.
    expect(exampleValue({ const: "dog", example: "pup" }, schemas)).toBe("pup");
  });
});

describe("helpers.resolveComponentRef", () => {
  interface BodyLike {
    $ref?: string;
    description?: string;
  }
  const components = {
    requestBodies: { PetBody: { description: "A pet body" } },
    responses: { NotFound: { description: "Not found" } },
  };

  it("resolves requestBody and response $refs by section", () => {
    expect(
      resolveComponentRef<BodyLike>(
        { $ref: "#/components/requestBodies/PetBody" },
        components,
        "requestBodies"
      ).description
    ).toBe("A pet body");
    expect(
      resolveComponentRef<BodyLike>(
        { $ref: "#/components/responses/NotFound" },
        components,
        "responses"
      ).description
    ).toBe("Not found");
  });

  it("returns unresolvable nodes as-is", () => {
    const inline: BodyLike = { description: "inline" };
    expect(resolveComponentRef(inline, components, "responses")).toBe(inline);
    const unknown: BodyLike = { $ref: "#/components/responses/Nope" };
    expect(resolveComponentRef(unknown, components, "responses")).toBe(unknown);
    // A ref into another section must not resolve against this one.
    const wrongSection: BodyLike = {
      $ref: "#/components/requestBodies/PetBody",
    };
    expect(resolveComponentRef(wrongSection, components, "responses")).toBe(
      wrongSection
    );
    const malformed: BodyLike = { $ref: "#/nope" };
    expect(resolveComponentRef(malformed, components, "responses")).toBe(
      malformed
    );
    expect(resolveComponentRef(unknown, undefined, "responses")).toBe(unknown);
  });
});

describe("helpers.mergeParameters", () => {
  it("lets an operation parameter override a same-name+in path parameter", () => {
    const merged = mergeParameters(
      [
        { in: "query", name: "limit", schema: { type: "integer" } },
        { in: "query", name: "offset", schema: { type: "integer" } },
      ],
      [
        {
          in: "query",
          name: "limit",
          required: true,
          schema: { type: "integer" },
        },
        // Same name, different location: a distinct parameter, both kept.
        { in: "header", name: "limit" },
      ]
    );
    expect(
      merged.map((param) => [param.in, param.name, param.required ?? false])
    ).toStrictEqual([
      ["query", "limit", true],
      ["query", "offset", false],
      ["header", "limit", false],
    ]);
  });

  it("resolves parameter $refs before comparing", () => {
    const components = {
      parameters: {
        Limit: { description: "resolved", in: "query", name: "limit" },
      },
    };
    const merged = mergeParameters(
      [{ in: "query", name: "limit" }],
      [{ $ref: "#/components/parameters/Limit" }],
      components
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toBe("resolved");
  });

  it("keeps nameless (invalid) parameters distinct instead of dropping them", () => {
    expect(mergeParameters([{ in: "query" }], [{ in: "query" }])).toHaveLength(
      2
    );
  });
});

describe("snippets", () => {
  it("builds a request sample and renders each language", () => {
    const model = operationModel({
      method: "post",
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
      path: "/pet/{petId}",
      requestBody: {
        content: { "application/json": { schema: { type: "object" } } },
      },
      schemas,
      security: { alternatives: [], optional: false },
      servers: [{ url: "https://api.test/v1/" }],
    });
    const sample = buildRequest(model, defaultValues(model));
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

  it("renders one highlighted panel per sample language", async () => {
    // The panel builder every operation renderer shares (OpenAPI, AsyncAPI,
    // GraphQL): key/lang carry the config id, label the display name.
    const sample = {
      body: '{"query":"{ ping }"}',
      headers: { "Content-Type": "application/json" },
      method: "POST",
      url: "https://api.test/graphql",
    };
    const panels = await languageSamplePanels(
      sampleLanguages(["curl", "js"]),
      sample,
      { dark: "github-dark", light: "github-light" }
    );
    expect(panels.map((panel) => panel.key)).toStrictEqual(["curl", "js"]);
    expect(panels[0]?.label).toBe("cURL");
    expect(panels[0]?.lang).toBe("curl");
    expect(panels[0]?.html).toContain("astro-code");
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

  it("keeps JS and Python samples syntactically valid mid-edit", () => {
    // While the body editor holds invalid JSON (no `bodyValue` mirror), the
    // raw text can't be inlined as a JS/Python expression — it travels as a
    // string literal instead, matching what the live send transmits.
    const sample = {
      body: '{"count": 2',
      headers: {},
      method: "POST",
      url: "https://api.test/v1/pet",
    };
    const [js, python] = sampleLanguages(["js", "python"]).map((language) =>
      language.build(sample)
    );
    expect(js).toContain(String.raw`body: "{\"count\": 2"`);
    expect(js).not.toContain("JSON.stringify(");
    expect(python).toContain(String.raw`data="{\"count\": 2"`);
    expect(python).not.toContain("json=");
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

describe("security", () => {
  const SCHEMES = {
    apiCookie: { in: "cookie", name: "session", type: "apiKey" },
    apiHeader: {
      description: "Key from the dashboard.",
      in: "header",
      name: "X-Api-Key",
      type: "apiKey",
    },
    apiQuery: { in: "query", name: "api_key", type: "apiKey" },
    basicAuth: { scheme: "basic", type: "http" },
    bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
    oauth: { type: "oauth2" },
    oidc: { type: "openIdConnect" },
    tls: { type: "mutualTLS" },
  };

  it("prefers the operation's security and treats [] as public", () => {
    const root = [{ bearerAuth: [] }];
    expect(effectiveSecurity(undefined, root)).toStrictEqual(root);
    expect(effectiveSecurity([], root)).toStrictEqual([]);
    expect(effectiveSecurity([{ apiHeader: [] }], root)).toStrictEqual([
      { apiHeader: [] },
    ]);
    expect(effectiveSecurity()).toStrictEqual([]);
  });

  it("resolves requirement names against the component schemes", () => {
    const { alternatives, optional } = resolveSecurity(
      [{ bearerAuth: [] }, { apiHeader: [], apiQuery: [] }],
      SCHEMES
    );
    expect(optional).toBe(false);
    // Two OR alternatives; the second requires both schemes together.
    expect(alternatives).toHaveLength(2);
    expect(alternatives[0]?.[0]?.scheme).toBe(SCHEMES.bearerAuth);
    expect(alternatives[1]?.map((entry) => entry.key)).toStrictEqual([
      "apiHeader",
      "apiQuery",
    ]);
  });

  it("keeps an unknown scheme ref instead of dropping the requirement", () => {
    const { alternatives } = resolveSecurity([{ ghost: [] }], SCHEMES);
    expect(alternatives[0]?.[0]).toStrictEqual({
      key: "ghost",
      scheme: undefined,
      scopes: [],
    });
  });

  it("flags an empty requirement as optional auth, not an alternative", () => {
    const { alternatives, optional } = resolveSecurity(
      [{}, { bearerAuth: [] }],
      SCHEMES
    );
    expect(optional).toBe(true);
    expect(alternatives).toHaveLength(1);
  });

  it("carries OAuth scopes and ignores malformed entries", () => {
    const { alternatives } = resolveSecurity(
      [{ oauth: ["read:pets", "write:pets"] }],
      SCHEMES
    );
    expect(alternatives[0]?.[0]?.scopes).toStrictEqual([
      "read:pets",
      "write:pets",
    ]);
    // SAFETY: the scopes are deliberately a bare string — spec-invalid input
    // the resolver must ignore instead of crashing on.
    const malformed = resolveSecurity(
      [{ oauth: "read" as string | string[] }] as SecurityRequirementLike[],
      SCHEMES
    );
    expect(malformed.alternatives[0]?.[0]?.scopes).toStrictEqual([]);
  });

  it("labels schemes and locates their credential", () => {
    const resolved = (key: keyof typeof SCHEMES) => ({
      key,
      scheme: SCHEMES[key],
      scopes: [],
    });
    expect(schemeLabel(resolved("bearerAuth"))).toBe("Bearer token (JWT)");
    expect(schemeLabel(resolved("basicAuth"))).toBe("Basic auth");
    expect(schemeLabel(resolved("apiHeader"))).toBe("API key");
    expect(schemeLabel(resolved("oauth"))).toBe("OAuth2 access token");
    expect(schemeLabel(resolved("oidc"))).toBe("OpenID Connect token");
    expect(schemeLabel(resolved("tls"))).toBe("Mutual TLS");
    // A format-less bearer and a non-bearer/basic HTTP scheme.
    expect(
      schemeLabel({
        key: "plain",
        scheme: { scheme: "bearer", type: "http" },
        scopes: [],
      })
    ).toBe("Bearer token");
    expect(
      schemeLabel({
        key: "digest",
        scheme: { scheme: "digest", type: "http" },
        scopes: [],
      })
    ).toBe("HTTP digest");
    // Unknown ref: the component name is the only label available.
    expect(schemeLabel({ key: "ghost", scopes: [] })).toBe("ghost");

    expect(schemeCarrier(resolved("bearerAuth"))).toStrictEqual({
      in: "header",
      name: "Authorization",
    });
    expect(schemeCarrier(resolved("apiQuery"))).toStrictEqual({
      in: "query",
      name: "api_key",
    });
    expect(schemeCarrier(resolved("tls"))).toBeUndefined();
    expect(schemeCarrier({ key: "ghost", scopes: [] })).toBeUndefined();
  });

  it("threads auth placeholders into the request sample and snippets", () => {
    const security = resolveSecurity([{ bearerAuth: [] }], SCHEMES);
    const model = operationModel({
      method: "post",
      parameters: [],
      path: "/pet",
      schemas: {},
      security,
      servers: [{ url: "https://api.test/v1" }],
    });
    const sample = buildRequest(model, defaultValues(model));
    expect(sample.headers.Authorization).toBe("Bearer YOUR_TOKEN");
    const [curl] = sampleLanguages(["curl"]).map((language) =>
      language.build(sample)
    );
    expect(curl).toContain('-H "Authorization: Bearer YOUR_TOKEN"');
  });

  it("appends a query API key to the sample URL", () => {
    const security = resolveSecurity([{ apiQuery: [] }], SCHEMES);
    const model = operationModel({
      method: "get",
      parameters: [
        {
          in: "query",
          name: "verbose",
          required: true,
          schema: { type: "boolean" },
        },
      ],
      path: "/pet",
      schemas: {},
      security,
      servers: [{ url: "https://api.test/v1" }],
    });
    const sample = buildRequest(model, defaultValues(model));
    expect(sample.url).toBe(
      "https://api.test/v1/pet?verbose=true&api_key=YOUR_API_KEY"
    );
  });

  it("lets an explicit query parameter override the auth placeholder", () => {
    const security = resolveSecurity([{ apiQuery: [] }], SCHEMES);
    const model = operationModel({
      method: "get",
      parameters: [
        {
          example: "from-the-spec",
          in: "query",
          name: "api_key",
          required: true,
        },
      ],
      path: "/pet",
      schemas: {},
      security,
      servers: [{ url: "https://api.test/v1" }],
    });
    const sample = buildRequest(model, defaultValues(model));
    expect(sample.url).toBe("https://api.test/v1/pet?api_key=from-the-spec");
  });

  it("lets an explicit header parameter override the auth placeholder", () => {
    const security = resolveSecurity([{ bearerAuth: [] }], SCHEMES);
    const model = operationModel({
      method: "get",
      parameters: [
        {
          example: "Bearer from-the-spec",
          in: "header",
          name: "Authorization",
          required: true,
        },
      ],
      path: "/pet",
      schemas: {},
      security,
      servers: [{ url: "https://api.test/v1" }],
    });
    const sample = buildRequest(model, defaultValues(model));
    expect(sample.headers.Authorization).toBe("Bearer from-the-spec");
  });
});
