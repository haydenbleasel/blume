import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  introspectionFromSchema,
  buildSchema as referenceSchema,
} from "graphql";
import { join } from "pathe";

import {
  exampleQuery,
  exampleResponse,
  exampleVariables,
  GRAPHQL_ENDPOINT_PLACEHOLDER,
  graphqlOperationRoutes,
  graphqlPlaygroundModel,
  graphqlRoutes,
  graphqlUsage,
  isOutputField,
  selectionSet,
} from "../src/components/openapi/graphql-helpers.ts";
import {
  buildRequest,
  defaultValues,
} from "../src/components/openapi/request.ts";
import type { BlumeConfig } from "../src/core/config-input.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { serverFeatures } from "../src/core/server-features.ts";
import { buildGraphqlDocument } from "../src/openapi/graphql-build.ts";
import {
  extractGraphqlOperations,
  graphqlRootField,
  graphqlTypeDef,
  isGraphqlOperationKind,
} from "../src/openapi/graphql.ts";
import type { ApiOperationRef, ApiSpecData } from "../src/openapi/model.ts";
import { InvalidSpecError, parseGraphqlSpec } from "../src/openapi/parse.ts";
import {
  needsPlaygroundProxy,
  resolveReferences,
} from "../src/openapi/references.ts";
import { operationMdx } from "../src/openapi/render-mdx.ts";
import { openApiSource } from "../src/openapi/source.ts";

/**
 * One SDL fixture exercising every member kind the pipeline models: root
 * fields across all three operation kinds, deprecations with reasons, argument
 * defaults, an interface with an implementer, a union, a deprecated enum
 * value, nested/recursive input objects, and a custom scalar with a
 * `specifiedBy` URL. `Pet.tags` declares a required argument so selection-set
 * generation must skip it; `Owner.pets` closes a Pet→Owner→Pet cycle the
 * depth bound must cut.
 */
const SDL = `
"""The pet store GraphQL API."""
schema {
  query: Query
  mutation: Mutation
  subscription: Subscription
}

type Query {
  "List pets."
  pets(limit: Int = 10, sort: SortOrder = ASC, filter: PetFilter): [Pet!]!
  pet(id: ID!): Pet
  search(term: String!): SearchResult
  legacy: String @deprecated(reason: "Use pets.")
}

type Mutation {
  addPet(input: AddPetInput!): Pet!
}

type Subscription {
  petAdded: Pet!
}

"A pet in the store."
type Pet implements Node {
  id: ID!
  name: String!
  status: PetStatus
  owner: Owner
  tags(first: Int!): [String!]
  bornAt: Date
}

type Owner {
  id: ID!
  name: String
  pets: [Pet!]!
}

interface Node {
  id: ID!
}

union SearchResult = Pet | Owner

enum SortOrder {
  ASC
  DESC
}

enum PetStatus {
  "Ready to adopt."
  AVAILABLE
  SOLD @deprecated(reason: "No longer tracked.")
}

input PetFilter {
  status: PetStatus = AVAILABLE
  nested: PetFilter
  name: String @deprecated(reason: "Use status.")
}

input AddPetInput {
  name: String!
  status: PetStatus
}

scalar Date @specifiedBy(url: "https://example.com/date")
`;

const document = buildGraphqlDocument(SDL);

const specData = (overrides: Partial<ApiSpecData> = {}): ApiSpecData => {
  const extracted = extractGraphqlOperations(document, "/graphql");
  return {
    codeSamples: ["curl", "js"],
    description: "The pet store GraphQL API.",
    document,
    expandSchemas: false,
    kind: "graphql",
    label: "GraphQL",
    operations: Object.fromEntries(
      extracted.operations.map((operation) => [operation.key, operation])
    ),
    playground: { enabled: true, proxy: false },
    route: "/graphql",
    slug: "graphql",
    tags: extracted.tags,
    title: "GraphQL",
    version: "",
    ...overrides,
  };
};

const parse = (input: BlumeConfig) => blumeConfigSchema.parse(input);

const refFor = (spec: ApiSpecData, key: string): ApiOperationRef => {
  const ref = spec.operations[key];
  if (!ref) {
    throw new Error(`fixture ref ${key} missing`);
  }
  return ref;
};

describe("graphql-build.buildGraphqlDocument", () => {
  it("lowers SDL to a serializable document", () => {
    expect(document.info?.description).toBe("The pet store GraphQL API.");
    expect(document.roots).toStrictEqual({
      mutation: "Mutation",
      query: "Query",
      subscription: "Subscription",
    });
    // Introspection meta-types are excluded; built-in scalars stay, marked.
    expect(Object.keys(document.types).some((n) => n.startsWith("__"))).toBe(
      false
    );
    expect(document.types.String?.builtIn).toBe(true);
    expect(document.types.Date?.builtIn).toBeUndefined();
    expect(document.types.Date?.specifiedByUrl).toBe(
      "https://example.com/date"
    );
  });

  it("captures fields, args, defaults, and deprecations", () => {
    const pets = document.types.Query?.fields?.find((f) => f.name === "pets");
    expect(pets?.description).toBe("List pets.");
    expect(pets?.type).toStrictEqual({ display: "[Pet!]!", name: "Pet" });
    expect(pets?.args.map((arg) => arg.default)).toStrictEqual([
      "10",
      "ASC",
      undefined,
    ]);
    const legacy = document.types.Query?.fields?.find(
      (f) => f.name === "legacy"
    );
    expect(legacy?.deprecationReason).toBe("Use pets.");
    const name = document.types.PetFilter?.inputFields?.find(
      (f) => f.name === "name"
    );
    expect(name?.deprecationReason).toBe("Use status.");
    expect(
      document.types.PetFilter?.inputFields?.find((f) => f.name === "status")
        ?.default
    ).toBe("AVAILABLE");
  });

  it("captures interfaces, implementers, unions, and enum values", () => {
    expect(document.types.Pet?.interfaces).toStrictEqual(["Node"]);
    expect(document.types.Node?.possibleTypes).toStrictEqual(["Pet"]);
    expect(document.types.SearchResult?.possibleTypes).toStrictEqual([
      "Pet",
      "Owner",
    ]);
    const sold = document.types.PetStatus?.enumValues?.find(
      (value) => value.name === "SOLD"
    );
    expect(sold?.deprecationReason).toBe("No longer tracked.");
    expect(
      document.types.PetStatus?.enumValues?.find(
        (value) => value.name === "AVAILABLE"
      )?.description
    ).toBe("Ready to adopt.");
  });

  it("reads an introspection JSON result, bare or enveloped", () => {
    const introspection = introspectionFromSchema(referenceSchema(SDL));
    const bare = buildGraphqlDocument(JSON.stringify(introspection));
    expect(bare.roots.query).toBe("Query");
    expect(
      bare.types.Query?.fields?.find((f) => f.name === "pets")?.args[0]?.default
    ).toBe("10");
    const enveloped = buildGraphqlDocument(
      JSON.stringify({ data: introspection })
    );
    expect(enveloped.types.Pet?.kind).toBe("object");
  });

  it("omits absent root types", () => {
    const queryOnly = buildGraphqlDocument("type Query { ping: String }");
    expect(queryOnly.roots).toStrictEqual({ query: "Query" });
    expect(queryOnly.info?.description).toBe("");
  });

  it("rejects JSON that is not an introspection result", () => {
    expect(() => buildGraphqlDocument('{"foo": 1}')).toThrow("__schema");
    expect(() => buildGraphqlDocument('{"data": {"x": 1}}')).toThrow(
      "__schema"
    );
    expect(() => buildGraphqlDocument('{"data": null}')).toThrow("__schema");
    expect(() => buildGraphqlDocument("42")).toThrow("__schema");
  });

  it("rejects invalid SDL", () => {
    expect(() => buildGraphqlDocument("type {")).toThrow();
  });
});

describe("graphql.extractGraphqlOperations", () => {
  const extracted = extractGraphqlOperations(document, "/graphql");

  it("emits root fields grouped by operation kind, then types by kind", () => {
    expect(extracted.warnings).toStrictEqual([]);
    expect(extracted.tags.map((tag) => tag.name)).toStrictEqual([
      "Queries",
      "Mutations",
      "Subscriptions",
      "Objects",
      "Input Objects",
      "Enums",
      "Interfaces",
      "Unions",
      "Scalars",
    ]);
    const pets = extracted.operations.find((op) => op.operationId === "pets");
    expect(pets?.route).toBe("/graphql/queries/pets");
    expect(pets?.method).toBe("query");
    expect(pets?.summary).toBe("");
    expect(pets?.path).toBe("pets");
    const addPet = extracted.operations.find(
      (op) => op.operationId === "addPet"
    );
    expect(addPet?.route).toBe("/graphql/mutations/addpet");
  });

  it("marks deprecated root fields", () => {
    const legacy = extracted.operations.find(
      (op) => op.operationId === "legacy"
    );
    expect(legacy?.deprecated).toBe(true);
    const pets = extracted.operations.find((op) => op.operationId === "pets");
    expect(pets?.deprecated).toBe(false);
  });

  it("pages every named type except built-ins and roots, sorted by name", () => {
    const objects = extracted.operations.filter((op) => op.method === "object");
    expect(objects.map((op) => op.operationId)).toStrictEqual(["Owner", "Pet"]);
    const names = extracted.operations.map((op) => op.operationId);
    expect(names).not.toContain("Query");
    expect(names).not.toContain("String");
    expect(names).toContain("Date");
    expect(names).toContain("Node");
    expect(names).toContain("SearchResult");
  });

  it("disambiguates a type page whose slug collides with a root field", () => {
    // Query field `pet` claims the `pet` key; the `Pet` type page collides and
    // gains its kind as a suffix — two distinct routes, no silent overwrite.
    const field = extracted.operations.find((op) => op.operationId === "pet");
    const type = extracted.operations.find(
      (op) => op.operationId === "Pet" && op.method === "object"
    );
    expect(field?.key).toBe("pet");
    expect(type?.key).toBe("pet-object");
    expect(type?.route).toBe("/graphql/objects/pet-object");
  });

  it("still pages a rootless schema's custom types", () => {
    const empty = extractGraphqlOperations(
      buildGraphqlDocument("scalar Odd"),
      "/graphql"
    );
    expect(empty.operations.map((op) => op.operationId)).toStrictEqual(["Odd"]);
  });
});

describe("graphql lookups", () => {
  const spec = specData();

  it("resolves root fields and type defs from their refs", () => {
    const pets = graphqlRootField(document, refFor(spec, "pets"));
    expect(pets?.name).toBe("pets");
    const type = graphqlTypeDef(document, refFor(spec, "pet-object"));
    expect(type?.name).toBe("Pet");
  });

  it("returns undefined for mismatched or missing refs", () => {
    // A type-page ref is not a root field...
    expect(
      graphqlRootField(document, refFor(spec, "pet-object"))
    ).toBeUndefined();
    // ...and a root-field ref is not a type page (kind mismatch).
    expect(graphqlTypeDef(document, refFor(spec, "pets"))).toBeUndefined();
    // A ref whose field vanished from the schema resolves to nothing.
    expect(
      graphqlRootField(document, {
        ...refFor(spec, "pets"),
        operationId: "gone",
      })
    ).toBeUndefined();
    // A ref whose operation kind has no root type resolves to nothing.
    expect(
      graphqlRootField(buildGraphqlDocument("type Query { ping: String }"), {
        ...refFor(spec, "petadded"),
      })
    ).toBeUndefined();
    expect(
      graphqlTypeDef(document, {
        ...refFor(spec, "pet-object"),
        operationId: undefined,
      })
    ).toBeUndefined();
    expect(isGraphqlOperationKind("query")).toBe(true);
    expect(isGraphqlOperationKind("object")).toBe(false);
  });
});

describe("graphql config and references", () => {
  it("defaults the block off with a /graphql route", () => {
    const config = blumeConfigSchema.parse({});
    expect(config.graphql.enabled).toBe(false);
    expect(config.graphql.route).toBe("/graphql");
    expect(config.graphql.codeSamples).toStrictEqual(["curl", "js", "python"]);
    expect(config.graphql.playground).toStrictEqual({
      enabled: true,
      proxy: false,
    });
    expect(resolveReferences(config)).toStrictEqual([]);
  });

  it("resolves a Blume-rendered GraphQL reference", () => {
    const config = blumeConfigSchema.parse({
      graphql: {
        enabled: true,
        endpoint: "https://api.test/graphql",
        spec: "schema.graphql",
      },
    });
    const refs = resolveReferences(config);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.kind).toBe("graphql");
    expect(refs[0]?.renderer).toBe("blume");
    expect(refs[0]?.slug).toBe("graphql");
    expect(refs[0]?.endpoint).toBe("https://api.test/graphql");
    expect(refs[0]?.display).toStrictEqual({
      codeSamples: ["curl", "js", "python"],
      expandSchemas: false,
      playground: { enabled: true, proxy: false },
    });
  });

  it("lets a per-source endpoint win over the block default", () => {
    const config = blumeConfigSchema.parse({
      graphql: {
        enabled: true,
        endpoint: "https://shared.test/graphql",
        sources: [
          { label: "Main", spec: "a.graphql" },
          {
            endpoint: "https://other.test/graphql",
            label: "Other",
            spec: "b.graphql",
          },
        ],
      },
    });
    const refs = resolveReferences(config);
    expect(refs.map((ref) => ref.endpoint)).toStrictEqual([
      "https://shared.test/graphql",
      "https://other.test/graphql",
    ]);
  });

  it("gates the built-in proxy endpoint on either block", () => {
    expect(needsPlaygroundProxy(parse({}))).toBe(false);
    expect(
      needsPlaygroundProxy(
        parse({ openapi: { enabled: true, playground: { proxy: true } } })
      )
    ).toBe(true);
    expect(
      needsPlaygroundProxy(
        parse({
          openapi: {
            enabled: true,
            playground: { proxy: true },
            renderer: "scalar",
          },
        })
      )
    ).toBe(false);
    expect(
      needsPlaygroundProxy(
        parse({
          openapi: {
            enabled: true,
            playground: { enabled: false, proxy: true },
          },
        })
      )
    ).toBe(false);
    expect(
      needsPlaygroundProxy(
        parse({ graphql: { enabled: true, playground: { proxy: true } } })
      )
    ).toBe(true);
    expect(needsPlaygroundProxy(parse({ graphql: { enabled: true } }))).toBe(
      false
    );
    expect(
      needsPlaygroundProxy(parse({ graphql: { playground: { proxy: true } } }))
    ).toBe(false);
    expect(
      needsPlaygroundProxy(
        parse({
          graphql: {
            enabled: true,
            playground: { enabled: false, proxy: true },
          },
        })
      )
    ).toBe(false);
    // An external proxy URL keeps the build static.
    expect(
      needsPlaygroundProxy(
        parse({
          graphql: {
            enabled: true,
            playground: { proxy: "https://proxy.test" },
          },
        })
      )
    ).toBe(false);
  });

  it("reports the proxy as a server feature for the GraphQL block", () => {
    const config = blumeConfigSchema.parse({
      graphql: { enabled: true, playground: { proxy: true } },
    });
    expect(serverFeatures(config)).toContain("API playground proxy");
  });
});

describe("parse.parseGraphqlSpec", () => {
  it("reads a local SDL file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-graphql-"));
    await writeFile(join(dir, "schema.graphql"), SDL);
    const parsed = await parseGraphqlSpec("schema.graphql", dir);
    expect(parsed.warnings).toStrictEqual([]);
    expect(parsed.document.roots.query).toBe("Query");
    await rm(dir, { force: true, recursive: true });
  });

  it("throws InvalidSpecError for readable-but-invalid schema text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-graphql-"));
    await writeFile(join(dir, "schema.graphql"), "type {");
    await expect(parseGraphqlSpec("schema.graphql", dir)).rejects.toThrow(
      InvalidSpecError
    );
    await expect(parseGraphqlSpec("schema.graphql", dir)).rejects.toThrow(
      "not a valid GraphQL schema"
    );
    await rm(dir, { force: true, recursive: true });
  });
});

const ctx = (projectRoot: string) => ({
  cacheDir: join(projectRoot, ".blume/cache/openapi"),
  mode: "build" as const,
  projectRoot,
});

const reference = (spec: string, overrides: { endpoint?: string } = {}) => ({
  basePath: "",
  display: {
    codeSamples: ["curl"],
    expandSchemas: false,
    playground: { enabled: true, proxy: false as const },
  },
  includeInLlms: true,
  includeInSearch: true,
  kind: "graphql" as const,
  label: "GraphQL",
  noindex: false,
  renderer: "blume" as const,
  route: "/graphql",
  slug: "graphql",
  spec,
  ...overrides,
});

describe("source.openApiSource (graphql)", () => {
  it("stages one page per member plus an overview, with group labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-graphql-src-"));
    await writeFile(join(dir, "schema.graphql"), SDL);
    const source = openApiSource(
      [reference("schema.graphql", { endpoint: "https://api.test/graphql" })],
      ctx(dir)
    );
    const { entries, diagnostics, folderMeta } = await source.load();
    expect(diagnostics).toStrictEqual([]);
    const refs = entries.map((entry) => entry.ref);
    expect(refs).toContain("graphql/queries/pets.mdx");
    expect(refs).toContain("graphql/objects/pet-object.mdx");
    expect(refs.at(-1)).toBe("graphql/index.mdx");
    expect(folderMeta?.["graphql/queries"]).toStrictEqual({
      title: "Queries",
    });
    expect(folderMeta?.["graphql/input-objects"]).toStrictEqual({
      title: "Input Objects",
    });

    const spec = source.openApiData().graphql;
    expect(spec?.kind).toBe("graphql");
    expect(spec?.endpoint).toBe("https://api.test/graphql");
    // A schema names no title; the reference label stands in, and the schema
    // description becomes the overview prose.
    expect(spec?.title).toBe("GraphQL");
    expect(spec?.description).toBe("The pet store GraphQL API.");
    await rm(dir, { force: true, recursive: true });
  });

  it("warns on a schema with nothing to page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-graphql-src-"));
    // A directive-only schema declares no root fields and no pageable types,
    // so the reference would be an empty shell behind a nav tab.
    await writeFile(
      join(dir, "schema.graphql"),
      "directive @internal on FIELD_DEFINITION"
    );
    const source = openApiSource([reference("schema.graphql")], ctx(dir));
    const { diagnostics } = await source.load();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_GRAPHQL_EMPTY");
    expect(diagnostics[0]?.suggestion).toContain("root types declare fields");
    await rm(dir, { force: true, recursive: true });
  });

  it("reports an invalid schema as a content problem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blume-graphql-src-"));
    await writeFile(join(dir, "schema.graphql"), "type {");
    const source = openApiSource([reference("schema.graphql")], ctx(dir));
    const { diagnostics, entries } = await source.load();
    expect(entries).toStrictEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_GRAPHQL_UNAVAILABLE");
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.message).toContain("GraphQL spec");
    expect(diagnostics[0]?.suggestion).toContain("SDL text");
    await rm(dir, { force: true, recursive: true });
  });
});

describe("render-mdx (graphql)", () => {
  const spec = specData();

  it("titles operation pages by their field name", () => {
    const page = operationMdx(spec, refFor(spec, "pets"));
    expect(page.data.title).toBe("pets");
    expect(page.data.sidebar).toStrictEqual({ badge: "QUERY", label: "pets" });
    expect(page.data.seo.description).toBe(
      "List pets. Reference for the pets query in the GraphQL API."
    );
    expect(page.body).toContain('<Operation source="graphql" id="pets" />');
  });

  it("describes type pages by their kind", () => {
    const page = operationMdx(spec, refFor(spec, "pet-object"));
    expect(page.data.title).toBe("Pet");
    expect(page.data.seo.description).toBe(
      "A pet in the store. Reference for the Pet object type in the GraphQL API."
    );
    const input = operationMdx(spec, refFor(spec, "addpetinput"));
    expect(input.data.seo.description).toContain(
      "AddPetInput input object type"
    );
  });

  it("keeps kind badges off type pages and internal tokens out of search", () => {
    // A type page's kind already heads its sidebar group ("Objects"), so an
    // `OBJECT` badge would only repeat it — and the uppercased member kind is
    // an internal token that must not leak into search tags on any GraphQL
    // page.
    const operation = operationMdx(spec, refFor(spec, "pets"));
    expect(operation.data.search?.tags).toStrictEqual(["Queries"]);
    const page = operationMdx(spec, refFor(spec, "pet-object"));
    expect(page.data.sidebar).toStrictEqual({ label: "Pet" });
    expect(page.data.search?.tags).toStrictEqual(["Objects"]);
  });
});

describe("graphql-helpers", () => {
  const spec = specData({ endpoint: "https://api.test/graphql" });
  const pets = graphqlRootField(document, refFor(spec, "pets"));
  if (!pets) {
    throw new Error("fixture field missing");
  }

  it("builds a bounded, cycle-safe selection set", () => {
    const selections = selectionSet(document, "Pet");
    expect(selections?.map((s) => s.name)).toStrictEqual([
      "id",
      "name",
      "status",
      "owner",
      "bornAt",
    ]);
    // Owner nests one level deeper; its own composite field (pets) is cut by
    // the depth bound, and Pet.tags never appears (required argument).
    const owner = selections?.find((s) => s.name === "owner");
    expect(owner?.children?.map((s) => s.name)).toStrictEqual(["id", "name"]);
  });

  it("keeps fields whose required arguments carry defaults", () => {
    // `size: Int! = 128` is omittable per the GraphQL spec — only a non-null
    // argument with no default forces the field out of the example selection.
    const doc = buildGraphqlDocument(
      `type Query { pet: Pet }
       type Pet { id: ID, photo(size: Int! = 128): String, tag(first: Int!): String }`
    );
    expect(selectionSet(doc, "Pet")?.map((s) => s.name)).toStrictEqual([
      "id",
      "photo",
    ]);
  });

  it("selects __typename for unions and empty composites", () => {
    expect(selectionSet(document, "SearchResult")).toStrictEqual([
      { name: "__typename" },
    ]);
    const onlyComposites = buildGraphqlDocument(
      "type Query { a: A } type A { b: B } type B { c: C } type C { id: ID }"
    );
    // At depth 1, A has only the composite field b — nothing selectable.
    expect(selectionSet(onlyComposites, "A", 1)).toStrictEqual([
      { name: "__typename" },
    ]);
    expect(selectionSet(document, "String")).toBeUndefined();
    expect(selectionSet(document, "Missing")).toBeUndefined();
  });

  it("generates a valid example operation with variables", () => {
    const query = exampleQuery(document, pets, "query");
    expect(query)
      .toBe(`query Pets($limit: Int, $sort: SortOrder, $filter: PetFilter) {
  pets(limit: $limit, sort: $sort, filter: $filter) {
    id
    name
    status
    owner {
      id
      name
    }
    bornAt
  }
}`);
    const legacy = graphqlRootField(document, refFor(spec, "legacy"));
    if (!legacy) {
      throw new Error("fixture field missing");
    }
    // A scalar return has no selection set; a field with no args no variables.
    expect(exampleQuery(document, legacy, "query")).toBe(
      "query Legacy {\n  legacy\n}"
    );
  });

  it("samples variables from argument types", () => {
    const variables = exampleVariables(document, pets);
    expect(variables?.limit).toBe(0);
    expect(variables?.sort).toBe("ASC");
    // Input objects nest to the depth bound; the recursive tail samples null.
    expect(variables?.filter).toStrictEqual({
      name: "string",
      nested: {
        name: "string",
        nested: { name: "string", nested: null, status: "AVAILABLE" },
        status: "AVAILABLE",
      },
      status: "AVAILABLE",
    });
    const legacy = graphqlRootField(document, refFor(spec, "legacy"));
    expect(exampleVariables(document, legacy ?? pets)).toBeUndefined();
  });

  it("samples non-null custom scalars and exhausted inputs as placeholders", () => {
    // `null` would be rejected by any real server for `Date!` — the sample
    // falls back to a placeholder string; a nullable position stays null, and
    // so does the element of `[Date]!`, whose non-null wraps the list.
    const doc = buildGraphqlDocument(
      `type Query { byDate(when: Date!, maybe: Date, days: [Date!]!, sparse: [Date]!): String }
       scalar Date`
    );
    const byDate = graphqlRootField(doc, {
      ...refFor(spec, "pets"),
      operationId: "byDate",
    });
    if (!byDate) {
      throw new Error("fixture field missing");
    }
    expect(exampleVariables(doc, byDate)).toStrictEqual({
      days: ["string"],
      maybe: null,
      sparse: [null],
      when: "string",
    });
    // A required input nested past the depth bound samples as an empty
    // object, not an invalid null.
    const deep = buildGraphqlDocument(
      `type Query { go(a: A!): String }
       input A { b: B! } input B { c: C! } input C { d: D! } input D { x: Int }`
    );
    const go = graphqlRootField(deep, {
      ...refFor(spec, "pets"),
      operationId: "go",
    });
    if (!go) {
      throw new Error("fixture field missing");
    }
    expect(exampleVariables(deep, go)).toStrictEqual({
      a: { b: { c: { d: {} } } },
    });
  });

  it("wraps nested lists to their full depth", () => {
    const doc = buildGraphqlDocument(
      "type Query { grid: [[Cell]] } type Cell { id: ID }"
    );
    const grid = graphqlRootField(doc, {
      ...refFor(spec, "pets"),
      operationId: "grid",
    });
    if (!grid) {
      throw new Error("fixture field missing");
    }
    expect(exampleResponse(doc, grid)).toStrictEqual({
      data: { grid: [[{ id: "id" }]] },
    });
  });

  it("mirrors the selection set in the example response", () => {
    const response = exampleResponse(document, pets);
    expect(response).toStrictEqual({
      data: {
        pets: [
          {
            bornAt: null,
            id: "id",
            name: "string",
            owner: { id: "id", name: "string" },
            status: "AVAILABLE",
          },
        ],
      },
    });
    // A union response names its first member via __typename.
    const search = graphqlRootField(document, refFor(spec, "search"));
    if (!search) {
      throw new Error("fixture field missing");
    }
    expect(exampleResponse(document, search)).toStrictEqual({
      data: { search: { __typename: "Pet" } },
    });
    // A scalar return skips the selection machinery entirely.
    const legacy = graphqlRootField(document, refFor(spec, "legacy"));
    if (!legacy) {
      throw new Error("fixture field missing");
    }
    expect(exampleResponse(document, legacy)).toStrictEqual({
      data: { legacy: "string" },
    });
  });

  it("wraps nested list fields in the response", () => {
    const listDoc = buildGraphqlDocument(
      "type Query { a: A } type A { rows: [B!]! } type B { id: ID }"
    );
    const a = graphqlRootField(listDoc, {
      ...refFor(spec, "pets"),
      operationId: "a",
    });
    if (!a) {
      throw new Error("fixture field missing");
    }
    expect(exampleResponse(listDoc, a)).toStrictEqual({
      data: { a: { rows: [{ id: "id" }] } },
    });
  });

  it("builds the shared playground/request model", () => {
    const query = exampleQuery(document, pets, "query");
    const variables = exampleVariables(document, pets);
    const model = graphqlPlaygroundModel(spec, query, variables);
    expect(model.method).toBe("POST");
    expect(model.servers).toStrictEqual(["https://api.test/graphql"]);
    const sample = buildRequest(model, defaultValues(model));
    expect(sample.url).toBe("https://api.test/graphql");
    expect(sample.headers["Content-Type"]).toBe("application/json");
    // The body is the exact JSON envelope a GraphQL server expects.
    expect(JSON.parse(sample.body ?? "")).toStrictEqual({
      query,
      variables,
    });
    // No endpoint configured: the placeholder keeps samples complete.
    const bare = graphqlPlaygroundModel(specData(), query);
    expect(bare.servers).toStrictEqual([GRAPHQL_ENDPOINT_PLACEHOLDER]);
    expect(JSON.parse(bare.body?.example ?? "")).toStrictEqual({ query });
  });

  it("maps type names to their page routes", () => {
    const routes = graphqlRoutes(spec);
    expect(routes.get("Pet")).toBe("/graphql/objects/pet-object");
    expect(routes.get("PetStatus")).toBe("/graphql/enums/petstatus");
    // Root fields never claim a type-name slot; built-ins have no page.
    expect(routes.get("pets")).toBeUndefined();
    expect(routes.get("String")).toBeUndefined();
  });

  it("maps operation pages by kind and field, memoized per spec", () => {
    const operations = graphqlOperationRoutes(spec);
    expect(operations.get("query:pets")).toBe("/graphql/queries/pets");
    expect(operations.get("mutation:addPet")).toBe("/graphql/mutations/addpet");
    expect(operations.get("pets")).toBeUndefined();
    // Both lookups derive from one walk of the spec, cached on the spec
    // object — page renders must not recompute them.
    expect(graphqlOperationRoutes(spec)).toBe(operations);
    expect(graphqlRoutes(spec)).toBe(graphqlRoutes(spec));
    // A ref with no operationId (possible on the shared ref shape) maps to
    // neither table.
    const anonymous = specData();
    anonymous.operations.anon = {
      ...refFor(anonymous, "pets"),
      key: "anon",
      operationId: undefined,
    };
    expect(graphqlOperationRoutes(anonymous).get("query:pets")).toBe(
      "/graphql/queries/pets"
    );
    expect(graphqlOperationRoutes(anonymous).has("query:anon")).toBe(false);
  });

  it("computes usage backlinks", () => {
    const usage = graphqlUsage(document, "Pet");
    expect(usage.operations).toStrictEqual([
      { kind: "query", name: "pets" },
      { kind: "query", name: "pet" },
      { kind: "mutation", name: "addPet" },
      { kind: "subscription", name: "petAdded" },
    ]);
    // Owner returns [Pet!]!, and the union carries Pet as a member.
    expect(usage.types).toStrictEqual(["Owner", "SearchResult"]);
    const statusUsage = graphqlUsage(document, "PetStatus");
    // Referenced by an object field, an input field, and a mutation argument
    // (through AddPetInput), but never by itself.
    expect(statusUsage.types).toContain("Pet");
    expect(statusUsage.types).toContain("PetFilter");
    expect(statusUsage.types).toContain("AddPetInput");
    expect(statusUsage.types).not.toContain("PetStatus");
    // A name nothing references (or that isn't a type at all) backlinks
    // nothing rather than throwing.
    expect(graphqlUsage(document, "Unreferenced")).toStrictEqual({
      operations: [],
      types: [],
    });
  });

  it("narrows table rows to output fields", () => {
    expect(isOutputField(pets)).toBe(true);
    const status = document.types.PetFilter?.inputFields?.[0];
    if (!status) {
      throw new Error("fixture input missing");
    }
    expect(isOutputField(status)).toBe(false);
  });
});
