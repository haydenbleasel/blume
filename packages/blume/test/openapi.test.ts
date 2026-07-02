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

  it("degrades to a warning when a spec cannot be loaded", async () => {
    const reference = {
      display: { codeSamples: [], expandSchemas: false },
      kind: "openapi" as const,
      label: "API",
      renderer: "blume" as const,
      route: "/api",
      slug: "api",
      spec: "missing.json",
    };
    const source = openApiSource([reference], ctx("/no/such/root"));
    const { entries, diagnostics } = await source.load();
    expect(entries).toStrictEqual([]);
    expect(diagnostics[0]?.code).toBe("BLUME_OPENAPI_UNAVAILABLE");
    expect(source.openApiData()).toStrictEqual({});
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
    expect(typeLabel({ $ref: "#/components/schemas/Pet" }, schemas)).toBe(
      "Pet"
    );
    expect(
      typeLabel({ items: { type: "string" }, type: "array" }, schemas)
    ).toBe("string[]");
    expect(
      typeLabel({ oneOf: [{ type: "string" }, { type: "number" }] }, schemas)
    ).toBe("string | number");
    expect(typeLabel({ allOf: [{ type: "object" }] }, schemas)).toBe("object");
    expect(typeLabel({ format: "int64", type: "integer" }, schemas)).toBe(
      "integer<int64>"
    );
    expect(typeLabel({}, schemas)).toBe("any");
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
