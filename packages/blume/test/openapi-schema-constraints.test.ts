import { describe, expect, it } from "bun:test";

import {
  allowedValues,
  constraints,
  exampleValue,
  jsonLiteral,
  mergeSchemas,
  objectProperties,
  resolveSchema,
  typeLabel,
  validationSchema,
} from "../src/components/openapi/helpers.ts";
import type {
  SchemaLike,
  SpecValue,
} from "../src/components/openapi/helpers.ts";
import { schemaTree } from "../src/components/openapi/schema-tree.ts";
import type { SchemaNode } from "../src/components/openapi/schema-tree.ts";
import { validateJson } from "../src/components/openapi/validate-json.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";

/**
 * JSON Schema constraints the tables and examples used to drop: a `oneOf` of
 * branches that only add `required`, maps, `""` and `null` enum values,
 * `required` beside a `$ref`, a property two `allOf` members constrain, and
 * `not`. The examples must also pass the schema they illustrate.
 */

const ref = (name: string): SchemaLike => ({
  $ref: `#/components/schemas/${name}`,
});

const SCHEMAS = {
  Customer: {
    anyOf: [{ required: ["id"] }, { required: ["email"] }],
    properties: { email: { type: "string" }, id: { type: "string" } },
    type: "object",
  },
  Named: {
    allOf: [
      { properties: { name: { maxLength: 10, type: "string" } } },
      { properties: { name: { minLength: 1, type: "string" } } },
    ],
  },
  Order: {
    oneOf: [{ required: ["card"] }, { required: ["iban"] }],
    properties: {
      amount: { type: "number" },
      card: { type: "string" },
      code: { not: { const: "reserved" }, type: "string" },
      customer: ref("Customer"),
      iban: { type: "string" },
      labels: { additionalProperties: { type: "string" }, type: "object" },
      named: ref("Named"),
      owner: { ...ref("Person"), required: ["email"] },
      status: { enum: ["open", "closed", ""], type: "string" },
    },
    required: ["amount"],
    type: "object",
  },
  Person: {
    properties: { email: { type: "string" }, name: { type: "string" } },
    required: ["name"],
    type: "object",
  },
} satisfies Record<string, SchemaLike>;

const STRINGS = {
  ...EN_UI.reference,
  notAllowed: "{path} not in {values}",
  requiredMissing: "{path} missing",
  schemaMismatch: "{path} mismatch",
};

const branchesOf = (node: SchemaNode) =>
  node.kind === "branches" ? node : undefined;

describe("schema tables", () => {
  it("labels a schema narrowed by its variants by its own type", () => {
    expect(typeLabel(SCHEMAS.Order)).toBe("object");
    expect(typeLabel(SCHEMAS.Customer)).toBe("object");
    expect(typeLabel({ oneOf: [{ required: ["a"] }] })).toBe("any");
    expect(typeLabel({ oneOf: [] })).toBe("any");
  });

  it("labels maps by their value schema", () => {
    expect(typeLabel(SCHEMAS.Order.properties.labels)).toBe(
      "map<string, string>"
    );
    expect(typeLabel({ additionalProperties: ref("Person") })).toBe(
      "map<string, Person>"
    );
    expect(typeLabel({ additionalProperties: true, type: "object" })).toBe(
      "map<string, any>"
    );
    expect(typeLabel({ additionalProperties: false, type: "object" })).toBe(
      "object"
    );
  });

  it("lists what each variant requires, under exactly one or at least one", () => {
    const order = branchesOf(schemaTree(ref("Order"), SCHEMAS));
    expect(order?.groups.map((group) => group.label)).toStrictEqual(["One of"]);
    expect(
      order?.groups[0]?.branches.map(({ label, slot }) => [
        label,
        slot.node.kind === "properties" &&
          slot.node.rows.map((row) => [row.name, row.required]),
      ])
    ).toStrictEqual([
      ["", [["card", true]]],
      ["", [["iban", true]]],
    ]);
    // A variant's own property, or a name the schema doesn't declare, is
    // not borrowed from the schema.
    const own = branchesOf(
      schemaTree(
        {
          oneOf: [
            { properties: { a: { type: "integer" } }, required: ["a", "b"] },
          ],
          properties: { a: { type: "string" } },
        },
        SCHEMAS
      )
    );
    expect(
      own?.groups[0]?.branches.map(
        ({ slot }) =>
          slot.node.kind === "properties" &&
          slot.node.rows.map((row) => [row.name, typeLabel(row.schema)])
      )
    ).toStrictEqual([[["a", "integer"]]]);
    // A schema with both keeps both; a variant that declares no type has the
    // schema's own.
    const both = branchesOf(
      schemaTree(
        {
          anyOf: [{ format: "email" }, { format: "uri" }],
          oneOf: [{ maxLength: 5 }, { minLength: 10 }],
          type: "string",
        },
        SCHEMAS
      )
    );
    expect(
      both?.groups.map((group) => [
        group.label,
        group.branches.map(({ slot }) => slot.node),
      ])
    ).toStrictEqual([
      [
        "One of",
        [
          {
            kind: "type",
            label: "string",
            schema: { maxLength: 5, type: "string" },
          },
          {
            kind: "type",
            label: "string",
            schema: { minLength: 10, type: "string" },
          },
        ],
      ],
      [
        "Any of",
        [
          {
            kind: "type",
            label: "string<email>",
            schema: { format: "email", type: "string" },
          },
          {
            kind: "type",
            label: "string<uri>",
            schema: { format: "uri", type: "string" },
          },
        ],
      ],
    ]);
  });

  it("shows a map's values as a row of its own", () => {
    const node = schemaTree(
      {
        additionalProperties: ref("Person"),
        properties: { total: { type: "integer" } },
        type: "object",
      },
      SCHEMAS
    );
    expect(
      node.kind === "properties" &&
        node.rows.map((row) => [row.name, row.children?.node.kind])
    ).toStrictEqual([
      ["total", undefined],
      ["[key: string]", "properties"],
    ]);
    const map = schemaTree(
      { properties: { byId: { additionalProperties: ref("Person") } } },
      SCHEMAS
    );
    expect(map.kind === "properties" && map.rows[0]?.children?.node.kind).toBe(
      "properties"
    );
  });

  it("keeps the constraints beside a $ref and of every allOf member", () => {
    expect(
      resolveSchema(SCHEMAS, SCHEMAS.Order.properties.owner).required
    ).toStrictEqual(["name", "email"]);
    expect(objectProperties(ref("Named"), SCHEMAS).properties).toStrictEqual([
      ["name", { maxLength: 10, minLength: 1, type: "string" }],
    ]);
  });

  it("merges two schemas on one value", () => {
    expect(
      mergeSchemas(
        {
          allOf: [ref("A")],
          enum: ["a", "b", null],
          maximum: 9,
          minimum: 1,
          properties: { x: { minLength: 2 } },
        },
        {
          allOf: [ref("B")],
          enum: [null, "b", "c"],
          maximum: 5,
          minimum: 3,
          properties: { x: { minLength: 4 }, y: { type: "string" } },
        }
      )
    ).toStrictEqual({
      allOf: [ref("A"), ref("B")],
      enum: ["b", null],
      maximum: 5,
      minimum: 3,
      properties: { x: { minLength: 4 }, y: { type: "string" } },
    });
    expect(mergeSchemas(ref("A"), ref("B"))).toStrictEqual({
      allOf: [ref("A"), ref("B")],
    });
    // Two different nots rule out both, and the table says so.
    const excluded = mergeSchemas(
      { not: { const: "reserved" }, type: "string" },
      { not: { const: "forbidden" } }
    );
    expect(excluded).toStrictEqual({
      not: { anyOf: [{ const: "reserved" }, { const: "forbidden" }] },
      type: "string",
    });
    expect(typeLabel(excluded)).toBe("string");
    expect(constraints(excluded, EN_UI.reference)).toStrictEqual([
      'not "reserved" | "forbidden"',
    ]);
    expect(exampleValue({ ...excluded, example: "reserved" }, {})).toBe(
      "string"
    );
    // A replaced anyOf still binds: only "b" satisfies both.
    const both = mergeSchemas(
      { anyOf: [{ const: "a" }, { const: "b" }] },
      { anyOf: [{ const: "b" }, { const: "c" }], default: "c" }
    );
    expect(both.allOf).toStrictEqual([
      { anyOf: [{ const: "a" }, { const: "b" }] },
    ]);
    expect(exampleValue(both, {})).toBeUndefined();
    const rules = validationSchema(both, {});
    expect(validateJson('"b"', STRINGS, rules)).toStrictEqual([]);
    expect(validateJson('"c"', STRINGS, rules)).toStrictEqual([
      "body mismatch",
    ]);
  });

  it("words what a not rules out, and enum values as JSON", () => {
    const strings = { ...EN_UI.reference };
    expect(constraints(SCHEMAS.Order.properties.code, strings)).toStrictEqual([
      'not "reserved"',
    ]);
    expect(constraints({ not: { enum: ["a", null] } }, strings)).toStrictEqual([
      'not "a" | null',
    ]);
    expect(constraints({ not: { type: "integer" } }, strings)).toStrictEqual([
      "not integer",
    ]);
    // A not that narrows further than its wording isn't worded at all:
    // "not object" would rule out more than `required: [a, b]` does.
    for (const not of [
      { required: ["a", "b"] },
      { anyOf: [{ const: "a" }, { minLength: 3, type: "string" }] },
    ]) {
      expect(constraints({ not }, strings)).toStrictEqual([]);
    }
    // The values a schema lists: its enum, else its const.
    expect(allowedValues({ const: null })).toStrictEqual([null]);
    expect(allowedValues({ enum: ["a"] })).toStrictEqual(["a"]);
    expect(allowedValues({ type: "string" })).toBeUndefined();
    // A variant that only lists a value or a limit keeps it on its card.
    const tagged = branchesOf(
      schemaTree(
        { oneOf: [{ const: "a" }, { const: "b" }], type: "string" },
        {}
      )
    );
    expect(
      tagged?.groups[0]?.branches.map(({ label, slot }) => [label, slot.node])
    ).toStrictEqual([
      [
        "",
        {
          kind: "type",
          label: "string",
          schema: { const: "a", type: "string" },
        },
      ],
      [
        "",
        {
          kind: "type",
          label: "string",
          schema: { const: "b", type: "string" },
        },
      ],
    ]);
    expect(["", null, "null", 1].map(jsonLiteral)).toStrictEqual([
      '""',
      "null",
      '"null"',
      "1",
    ]);
  });
});

describe("generated examples", () => {
  it("sends one side of a oneOf, and only a value the schema accepts", () => {
    const order = exampleValue(ref("Order"), SCHEMAS);
    expect(order).toMatchObject({ amount: 0, card: "string" });
    expect(order).not.toHaveProperty("iban");
    expect(order).toHaveProperty("owner.email");
    expect(
      validateJson(
        JSON.stringify(order),
        STRINGS,
        validationSchema(ref("Order"), SCHEMAS)
      )
    ).toStrictEqual([]);
    // Only the properties another variant requires go; one that requires
    // none takes none away.
    expect(
      exampleValue(
        {
          oneOf: [{ required: ["a"] }, { required: ["b"] }, { not: {} }],
          properties: { a: { type: "string" }, b: { type: "string" } },
          type: "object",
        },
        SCHEMAS
      )
    ).toStrictEqual({ a: "string" });
  });

  it("tells no example apart from an example of null", () => {
    expect(exampleValue({ type: "null" }, SCHEMAS)).toBeNull();
    // No value is both a string and not one.
    expect(
      exampleValue({ not: { type: "string" }, type: "string" }, SCHEMAS)
    ).toBeUndefined();
  });

  it("leaves out an example that breaks its schema", () => {
    expect(
      exampleValue({ enum: ["a", "b"], example: "c", type: "string" }, SCHEMAS)
    ).toBe("a");
    // Bounds count, in a oneOf too.
    expect(
      exampleValue({ example: "too long", maxLength: 3, type: "string" }, {})
    ).toBe("str");
    expect(
      exampleValue(
        { oneOf: [{ maximum: 0 }, { minimum: 1 }], type: "integer" },
        {}
      )
    ).toBe(0);
    // A property named like a keyword is still a property.
    expect(
      exampleValue(
        { properties: { example: { type: "boolean" } }, type: "object" },
        SCHEMAS
      )
    ).toStrictEqual({ example: true });
  });
});

describe("validation", () => {
  const order = validationSchema(ref("Order"), SCHEMAS);
  const check = (value: SpecValue) =>
    validateJson(JSON.stringify(value), STRINGS, order);

  it("checks oneOf, anyOf, not, const, maps, and null", () => {
    const valid = { amount: 1, card: "c", customer: { id: "1" } };
    expect(check(valid)).toStrictEqual([]);
    expect(check({ ...valid, iban: "i" })).toStrictEqual(["body mismatch"]);
    expect(check({ amount: 1 })).toStrictEqual(["body mismatch"]);
    expect(check({ ...valid, customer: {} })).toStrictEqual([
      "body.customer mismatch",
    ]);
    expect(check({ ...valid, code: "reserved" })).toStrictEqual([
      "body.code mismatch",
    ]);
    expect(check({ ...valid, labels: { a: 1 } })).toStrictEqual([
      "body.labels.a should be string, got number",
    ]);
    expect(
      validateJson('"b"', STRINGS, { const: "a" }, "payload")
    ).toStrictEqual(['payload not in "a"']);
    expect(validateJson("1", STRINGS, { type: "null" })).toHaveLength(1);
    // Bounds on numbers, strings, and arrays.
    for (const [text, schema] of [
      ["0", { exclusiveMinimum: 0 }],
      ["5", { exclusiveMaximum: 5 }],
      ["9", { maximum: 8 }],
      ['"ab"', { minLength: 3 }],
      ["[1, 2]", { maxItems: 1 }],
    ] as const) {
      expect(validateJson(text, STRINGS, schema)).toStrictEqual([
        "body mismatch",
      ]);
    }
    expect(validateJson("true", STRINGS, { minimum: 1 })).toStrictEqual([]);
    // A type the subset doesn't model checks nothing.
    expect(validateJson("1", STRINGS, { type: "file" })).toStrictEqual([]);
    expect(
      validateJson("1", STRINGS, { allOf: [{ type: "string" }] })
    ).toHaveLength(1);
  });

  it("compares const and enum objects whatever their key order", () => {
    expect(
      validateJson('{"b": 2, "a": 1}', STRINGS, { const: { a: 1, b: 2 } })
    ).toStrictEqual([]);
    expect(
      validateJson('{"b": 2, "a": 1}', STRINGS, { enum: [{ a: 1, b: 2 }] })
    ).toStrictEqual([]);
  });

  it("only loosens a not or a oneOf that holds a check it can't make", () => {
    // A pattern goes unchecked, so a not of one would rule out every string.
    expect(
      validationSchema({ not: { pattern: "^reserved$" }, type: "string" }, {})
    ).toStrictEqual({ type: "string" });
    for (const not of [
      { properties: { a: { pattern: "^a$" } } },
      { additionalProperties: false },
    ]) {
      expect(validationSchema({ not }, {})).toStrictEqual({});
    }
    // Variants told apart only by their patterns would all match: the oneOf
    // then checks that at least one does.
    const patterned = validationSchema(
      { oneOf: [{ pattern: "^a" }, { pattern: "^b" }], type: "string" },
      {}
    );
    expect(patterned).toStrictEqual({
      allOf: [{ anyOf: [{}, {}] }],
      type: "string",
    });
    expect(validateJson('"abc"', STRINGS, patterned)).toStrictEqual([]);
    expect(
      exampleValue({ not: { pattern: "^reserved$" }, type: "string" }, {})
    ).toBe("string");
  });

  it("drops a oneOf or not with a variant it can't check", () => {
    const loops = {
      Chain: { allOf: [ref("Chain"), { type: "string" }] },
      Loop: { oneOf: [ref("Loop"), { type: "string" }] },
    };
    expect(validationSchema(ref("Loop"), loops)).toStrictEqual({});
    // An allOf member binds on its own, so only the cut one goes.
    expect(validationSchema(ref("Chain"), loops)).toStrictEqual({
      allOf: [{ type: "string" }],
    });
  });

  it("requires a writeOnly property of a request only", () => {
    const schema: SchemaLike = {
      properties: {
        id: { readOnly: true, type: "string" },
        secret: { type: "string", writeOnly: true },
      },
      required: ["id", "secret"],
    };
    expect(validationSchema(schema, {})?.required).toStrictEqual(["secret"]);
    expect(validationSchema(schema, {}, "response")?.required).toStrictEqual([
      "id",
    ]);
  });
});
