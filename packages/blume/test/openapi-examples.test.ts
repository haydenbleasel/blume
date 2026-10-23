import { describe, expect, it } from "bun:test";

import { normalize, upgrade } from "@scalar/openapi-parser";

import {
  declaredExample,
  exampleValue,
  forDirection,
  resolveSchema,
  responseExample,
} from "../src/components/openapi/helpers.ts";
import type {
  ParameterLike,
  SchemaLike,
  SpecValue,
} from "../src/components/openapi/helpers.ts";
import { operationModel } from "../src/components/openapi/operation-model.ts";
import {
  buildRequest,
  defaultValues,
} from "../src/components/openapi/request.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";

/**
 * Author-written examples survive Scalar's upgrade: an OpenAPI 3.0 or Swagger
 * 2.0 `example` on a parameter or media type is moved into
 * `examples.default.value`, so the samples, the playground prefill, and the
 * Response panel read that location as well as a plain `example`.
 */

interface MediaType {
  schema?: SchemaLike;
  example?: SpecValue;
  examples?: SpecValue;
}

interface UpgradedOperation {
  parameters?: ParameterLike[];
  requestBody?: { content: Record<string, MediaType> };
  responses: Record<string, { content?: Record<string, MediaType> }>;
}

interface UpgradedDocument {
  components?: { schemas?: Record<string, SchemaLike> };
  paths: Record<string, { post?: UpgradedOperation }>;
}

/** Upgrade a document the way `parseSpec` does and pull out one operation. */
const upgraded = (spec: SpecValue, path: string) => {
  const { specification } = upgrade(normalize(JSON.stringify(spec)));
  // SAFETY: the fixtures below are OpenAPI documents, which the upgrade keeps
  // in this shape; the view names only the fields these tests read.
  const document = specification as UpgradedDocument;
  const operation = document.paths[path]?.post;
  if (!operation) {
    throw new Error(`fixture has no POST ${path}`);
  }
  return { operation, schemas: document.components?.schemas ?? {} };
};

const SPEC_30 = {
  components: {
    schemas: {
      Pet: {
        properties: {
          age: { type: "integer" },
          id: { readOnly: true, type: "string" },
          name: { type: "string" },
          password: { type: "string", writeOnly: true },
        },
        required: ["id", "name"],
        type: "object",
      },
    },
  },
  info: { title: "Pets", version: "1" },
  openapi: "3.0.3",
  paths: {
    "/pets/{petId}": {
      post: {
        parameters: [
          {
            example: "pet_123",
            in: "path",
            name: "petId",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              example: { age: 3, name: "Rex" },
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                example: { id: "pet_123", name: "Rex" },
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
            description: "The pet.",
          },
        },
      },
    },
  },
  servers: [{ url: "https://api.test" }],
};

describe("declared examples after the 3.1 upgrade", () => {
  it("reads a 3.0 parameter and body example from examples.default.value", () => {
    const { operation, schemas } = upgraded(SPEC_30, "/pets/{petId}");
    // The upgrade really did move them: the plain `example` is gone.
    expect(operation.parameters?.[0]?.example).toBeUndefined();
    const model = operationModel({
      method: "post",
      parameters: operation.parameters ?? [],
      path: "/pets/{petId}",
      requestBody: operation.requestBody,
      schemas,
      security: { alternatives: [], optional: false },
      servers: [{ url: "https://api.test" }],
      strings: EN_UI.reference,
    });
    const sample = buildRequest(model, defaultValues(model));
    expect(sample.url).toBe("https://api.test/pets/pet_123");
    expect(sample.bodyValue).toStrictEqual({ age: 3, name: "Rex" });
  });

  it("reads a Swagger 2.0 response example the same way", () => {
    const { operation, schemas } = upgraded(
      {
        info: { title: "Pets", version: "1" },
        paths: {
          "/pets": {
            post: {
              responses: {
                "200": {
                  description: "ok",
                  examples: { "application/json": { id: "p1" } },
                  schema: { type: "object" },
                },
              },
            },
          },
        },
        swagger: "2.0",
      },
      "/pets"
    );
    const media = operation.responses["200"]?.content?.["application/json"];
    expect(responseExample(media ?? {}, schemas)).toStrictEqual({ id: "p1" });
  });

  it("prefers a plain example, then the first inline examples value", () => {
    expect(
      declaredExample({ example: "a", examples: { x: { value: "b" } } })
    ).toBe("a");
    expect(
      declaredExample({
        examples: {
          ref: { $ref: "#/components/examples/Pet" },
          second: { value: "b" },
          third: { value: "c" },
        },
      })
    ).toBe("b");
    // Nothing declared, or nothing usable: the caller falls back to a sample.
    expect(declaredExample({})).toBeUndefined();
    expect(declaredExample({ examples: ["not", "a", "map"] })).toBeUndefined();
    expect(declaredExample({ examples: { only: "junk" } })).toBeUndefined();
  });
});

describe("response samples", () => {
  const schemas = {
    Account: {
      properties: {
        id: { readOnly: true, type: "string" },
        pw: { type: "string", writeOnly: true },
      },
      type: "object",
    },
  } satisfies Record<string, SchemaLike>;
  const account = { $ref: "#/components/schemas/Account" };

  it("keeps readOnly fields and skips writeOnly ones", () => {
    expect(responseExample({ schema: account }, schemas)).toStrictEqual({
      id: "string",
    });
  });

  it("leaves request samples skipping readOnly fields", () => {
    expect(exampleValue(account, schemas)).toStrictEqual({ pw: "string" });
  });
});

describe("flat body fields", () => {
  it("leaves out a readOnly property, as the request body's table does", () => {
    const model = operationModel({
      method: "post",
      parameters: [],
      path: "/accounts",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: {
                id: { readOnly: true, type: "string" },
                name: { type: "string" },
                slug: { $ref: "#/components/schemas/Slug" },
              },
              required: ["id", "name", "slug"],
              type: "object",
            },
          },
        },
      },
      schemas: { Slug: { readOnly: true, type: "string" } },
      security: { alternatives: [], optional: false },
      servers: [],
      strings: EN_UI.reference,
    });
    expect(
      model.body?.fields?.map((field) => [field.name, field.required])
    ).toStrictEqual([["name", true]]);
  });

  it("falls back to the editor when every property is readOnly", () => {
    const model = operationModel({
      method: "post",
      parameters: [],
      path: "/accounts",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: { id: { readOnly: true, type: "string" } },
              type: "object",
            },
          },
        },
      },
      schemas: {},
      security: { alternatives: [], optional: false },
      servers: [],
      strings: EN_UI.reference,
    });
    expect(model.body?.fields).toBeUndefined();
    expect(model.body?.example).toBe("{}");
  });
});

describe("examples follow the schema's direction", () => {
  // A TypeSpec model: the read-only `id` is in its model-level example.
  const schemas = {
    Owner: {
      properties: {
        id: { readOnly: true, type: "integer" },
        name: { type: "string" },
      },
      type: "object",
    },
    Pet: {
      example: { id: 7, name: "Rex", owner: { id: 1, name: "Ann" } },
      properties: {
        id: { readOnly: true, type: "integer" },
        name: { type: "string" },
        owner: { $ref: "#/components/schemas/Owner" },
        password: { type: "string", writeOnly: true },
      },
      type: "object",
    },
  } satisfies Record<string, SchemaLike>;
  const pet = { $ref: "#/components/schemas/Pet" };

  it("leaves readOnly properties out of a request sample, at any depth", () => {
    expect(exampleValue(pet, schemas)).toStrictEqual({
      name: "Rex",
      owner: { name: "Ann" },
    });
    expect(exampleValue({ items: pet, type: "array" }, schemas)).toStrictEqual([
      { name: "Rex", owner: { name: "Ann" } },
    ]);
  });

  it("leaves them out of the Try it prefill and the code samples", () => {
    const model = operationModel({
      method: "post",
      parameters: [],
      path: "/pets",
      requestBody: { content: { "application/json": { schema: pet } } },
      schemas,
      security: { alternatives: [], optional: false },
      servers: ["https://api.test"].map((url) => ({ url })),
      strings: EN_UI.reference,
    });
    expect(JSON.parse(model.body?.example ?? "")).toStrictEqual({
      name: "Rex",
      owner: { name: "Ann" },
    });
    expect(buildRequest(model, defaultValues(model)).body).toBe(
      model.body?.example
    );
  });

  it("leaves writeOnly properties out of a declared response example", () => {
    expect(
      responseExample(
        { example: { id: 7, password: "hunter2" }, schema: pet },
        schemas
      )
    ).toStrictEqual({ id: 7 });
  });

  it("keeps what the schema doesn't describe as written", () => {
    expect(
      forDirection([{ id: 1 }], { type: "array" }, schemas, "request")
    ).toStrictEqual([{ id: 1 }]);
    expect(forDirection({ id: 1 }, undefined, schemas, "request")).toEqual({
      id: 1,
    });
    expect(forDirection({ extra: 1 }, pet, schemas, "request")).toEqual({
      extra: 1,
    });
  });
});

describe("keywords beside a $ref", () => {
  const schemas = {
    Status: {
      description: "A pet's status.",
      enum: ["available", "sold"],
      type: "string",
    },
  } satisfies Record<string, SchemaLike>;

  it("reads the property's own description over the referenced one", () => {
    expect(
      resolveSchema(schemas, {
        $ref: "#/components/schemas/Status",
        description: "Where this pet is in the sale.",
      })
    ).toStrictEqual({
      description: "Where this pet is in the sale.",
      enum: ["available", "sold"],
      type: "string",
    });
    // With nothing beside it, a `$ref` is the referenced schema itself.
    expect(
      resolveSchema(schemas, { $ref: "#/components/schemas/Status" })
    ).toBe(schemas.Status);
  });

  it("samples the example written beside a $ref", () => {
    const body = {
      properties: {
        lifecycle: { $ref: "#/components/schemas/Status", default: "sold" },
        status: { $ref: "#/components/schemas/Status", example: "sold" },
        tagged: {
          $ref: "#/components/schemas/Status",
          allOf: [{ description: "Kept." }],
          examples: ["sold"],
        },
      },
      type: "object",
    };
    expect(exampleValue(body, schemas)).toStrictEqual({
      lifecycle: "sold",
      status: "sold",
      tagged: "sold",
    });
    // A component schema's own properties get the same reading.
    expect(
      exampleValue(
        { $ref: "#/components/schemas/Order" },
        {
          ...schemas,
          Order: {
            properties: {
              status: { $ref: "#/components/schemas/Status", example: "sold" },
            },
            type: "object",
          },
        }
      )
    ).toStrictEqual({ status: "sold" });
  });
});
