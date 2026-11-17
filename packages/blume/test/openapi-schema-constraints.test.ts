import { describe, expect, it } from "bun:test";

import { operationDetails } from "../src/ai/operation-details.ts";
import {
  allowedValues,
  anyOneOf,
  constraints,
  exampleValue,
  jsonLiteral,
  mediaExample,
  mergeSchemas,
  objectProperties,
  playgroundRules,
  resolveSchema,
  typeLabel,
  validationSchema,
} from "../src/components/openapi/helpers.ts";
import type {
  SchemaLike,
  SpecValue,
} from "../src/components/openapi/helpers.ts";
import type { ValidationSchema } from "../src/components/openapi/request.ts";
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
    // `true` and `{}` allow any value, which `object` already says.
    expect(typeLabel({ additionalProperties: true, type: "object" })).toBe(
      "object"
    );
    expect(typeLabel({ additionalProperties: {}, type: "object" })).toBe(
      "object"
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
    // Bounds on numbers, strings, and arrays, each named as the tables word
    // it.
    for (const [text, schema, limits] of [
      ["0", { exclusiveMinimum: 0 }, "greater than 0"],
      ["5", { exclusiveMaximum: 5 }, "less than 5"],
      ["0", { minimum: 1 }, "min 1"],
      ["9", { maximum: 8 }, "max 8"],
      ['"ab"', { minLength: 3 }, "min length 3"],
      ['"abcd"', { maxLength: 3 }, "max length 3"],
      ["[]", { minItems: 1 }, "min items 1"],
      ["[1, 2]", { maxItems: 1 }, "max items 1"],
    ] as const) {
      expect(validateJson(text, STRINGS, schema)).toStrictEqual([
        `body is out of range (${limits})`,
      ]);
    }
    expect(
      validateJson('"abcd"', STRINGS, { maxLength: 3, minLength: 5 })
    ).toStrictEqual(["body is out of range (min length 5 · max length 3)"]);
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
      { format: "email", type: "string" },
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

describe("oneOf variants that overlap", () => {
  const pets = {
    Cat: {
      allOf: [
        ref("Pet"),
        { properties: { name: { type: "string" } }, type: "object" },
      ],
    },
    Dog: {
      allOf: [
        ref("Pet"),
        { properties: { bark: { type: "string" } }, type: "object" },
      ],
    },
    Pet: {
      properties: { petType: { type: "string" } },
      required: ["petType"],
      type: "object",
    },
  } satisfies Record<string, SchemaLike>;

  it("checks a discriminated oneOf for one match or more", () => {
    // A Cat and a Dog are both a Pet, so a cat matches both variants; the
    // discriminator, not the match count, says which it is.
    const body: SchemaLike = {
      discriminator: { propertyName: "petType" },
      oneOf: [ref("Cat"), ref("Dog")],
    };
    expect(exampleValue(body, pets)).toStrictEqual({
      name: "string",
      petType: "string",
    });
    const rules = validationSchema(body, pets);
    expect(
      validateJson('{"name": "Tom", "petType": "Cat"}', STRINGS, rules)
    ).toStrictEqual([]);
    expect(validateJson("{}", STRINGS, rules)).toStrictEqual(["body mismatch"]);
  });

  it("samples overlapping variants for one match, and Try it takes the sample", () => {
    const body: SchemaLike = { oneOf: [ref("Cat"), ref("Dog")] };
    const example = exampleValue(body, pets);
    expect(example).toStrictEqual({ name: "string", petType: "string" });
    const text = JSON.stringify(example);
    expect(
      validateJson(text, STRINGS, validationSchema(body, pets))
    ).toStrictEqual(["body mismatch"]);
    const rules = playgroundRules(body, pets, example);
    expect(validateJson(text, STRINGS, rules)).toStrictEqual([]);
    expect(validateJson("{}", STRINGS, rules)).toStrictEqual(["body mismatch"]);
    expect(
      exampleValue({ oneOf: [{ type: "integer" }, { type: "number" }] }, {})
    ).toBe(0);
  });

  it("keeps a oneOf exact when its example tells the variants apart", () => {
    const order = ref("Order");
    const rules = validationSchema(order, SCHEMAS);
    // Pruned once, however many times the page asks.
    expect(validationSchema(order, SCHEMAS)).toBe(rules);
    const example = exampleValue(order, SCHEMAS);
    expect(playgroundRules(order, SCHEMAS, example)).toBe(rules);
    // No example, or one the loosened rules reject too, keeps them exact.
    expect(playgroundRules(order, SCHEMAS)).toBe(rules);
    expect(playgroundRules(order, SCHEMAS, "text")).toBe(rules);
    expect(playgroundRules(undefined, SCHEMAS, {})).toBeUndefined();
  });

  it("loosens every oneOf but the ones a not rules out", () => {
    const strict: ValidationSchema = {
      additionalProperties: { oneOf: [{}, {}] },
      allOf: [{ type: "object" }],
      anyOf: [{ oneOf: [{}] }],
      items: { oneOf: [{}] },
      not: { oneOf: [{ type: "string" }, {}] },
      oneOf: [{ required: ["a"] }],
      properties: { a: { oneOf: [{}] }, b: { type: "string" } },
    };
    expect(anyOneOf(strict)).toStrictEqual({
      additionalProperties: { allOf: [{ anyOf: [{}, {}] }] },
      allOf: [{ type: "object" }, { anyOf: [{ required: ["a"] }] }],
      anyOf: [{ allOf: [{ anyOf: [{}] }] }],
      items: { allOf: [{ anyOf: [{}] }] },
      not: { oneOf: [{ type: "string" }, {}] },
      properties: { a: { allOf: [{ anyOf: [{}] }] }, b: { type: "string" } },
    });
    const plain: ValidationSchema = { properties: { b: { type: "string" } } };
    expect(anyOneOf(plain)).toBe(plain);
  });

  it("tries each variant until one samples a value the schema takes", () => {
    const schemas = {
      Bank: {
        properties: { iban: { type: "string" } },
        required: ["iban"],
        type: "object",
      },
      // The sampler writes 0, which the not rules out.
      Card: {
        properties: { n: { not: { const: 0 }, type: "integer" } },
        required: ["n"],
        type: "object",
      },
    } satisfies Record<string, SchemaLike>;
    expect(
      exampleValue({ oneOf: [ref("Card"), ref("Bank")] }, schemas)
    ).toStrictEqual({ iban: "string" });
    expect(
      exampleValue(
        {
          oneOf: [{ required: ["a", "b"] }, { required: ["a"] }],
          properties: { a: { type: "string" }, b: { type: "string" } },
          type: "object",
        },
        {}
      )
    ).toStrictEqual({ a: "string" });
    // A narrower oneOf beside a wider one keeps its first variant.
    expect(
      exampleValue(
        {
          oneOf: [
            { not: {} },
            { not: {} },
            {
              properties: {
                x: { oneOf: [{ type: "string" }, { type: "integer" }] },
              },
              required: ["x"],
              type: "object",
            },
          ],
        },
        {}
      )
    ).toStrictEqual({ x: "string" });
  });
});

/** How many nodes a pruned schema holds, the way its budget counts them. */
const nodes = (schema: ValidationSchema | undefined): number =>
  schema
    ? 1 +
      [
        ...Object.values(schema.properties ?? {}),
        ...(schema.allOf ?? []),
        ...(schema.anyOf ?? []),
        schema.items,
      ].reduce((sum, member) => sum + nodes(member), 0)
    : 0;

describe("validation alongside other schemas on the value", () => {
  it("checks a cut property as itself, not as one of the other names", () => {
    const schemas = {
      Node: {
        additionalProperties: { type: "string" },
        properties: { child: ref("Node"), name: { type: "string" } },
        type: "object",
      },
    } satisfies Record<string, SchemaLike>;
    const rules = validationSchema(ref("Node"), schemas);
    expect(
      validateJson(
        '{"child": {"child": {"name": "c"}, "name": "b"}, "name": "a"}',
        STRINGS,
        rules
      )
    ).toStrictEqual([]);
    expect(validateJson('{"tag": 1}', STRINGS, rules)).toStrictEqual([
      "body.tag should be string, got number",
    ]);
    expect(exampleValue(ref("Node"), schemas)).toMatchObject({
      name: "string",
    });
    // Nor is a name a patternProperties schema takes, which goes unchecked.
    expect(
      validationSchema(
        {
          additionalProperties: { type: "string" },
          patternProperties: { "^x-": { type: "integer" } },
          type: "object",
        },
        {}
      )
    ).toStrictEqual({ type: "object" });
    // A name like an object's own key is a name like any other.
    expect(
      validateJson('{"constructor": 1}', STRINGS, {
        additionalProperties: { type: "string" },
      })
    ).toStrictEqual(["body.constructor should be string, got number"]);
  });

  it("leaves the names other allOf members declare to those members", () => {
    const schemas = {
      Base: { properties: { id: { type: "integer" } }, type: "object" },
    } satisfies Record<string, SchemaLike>;
    const tagged: SchemaLike = {
      allOf: [
        ref("Base"),
        { additionalProperties: { type: "string" }, type: "object" },
      ],
    };
    const rules = validationSchema(tagged, schemas);
    expect(validateJson('{"id": 1, "tag": "x"}', STRINGS, rules)).toStrictEqual(
      []
    );
    expect(validateJson('{"id": 1, "tag": 2}', STRINGS, rules)).toStrictEqual([
      "body.tag should be string, got number",
    ]);
    expect(validateJson('{"id": "1"}', STRINGS, rules)).toStrictEqual([
      "body.id should be integer, got string",
    ]);
    expect(exampleValue(tagged, schemas)).toMatchObject({ id: 0 });
  });

  it("knows a name an allOf member requires is another member's readOnly one", () => {
    const schemas = {
      Base: {
        properties: {
          id: { readOnly: true, type: "integer" },
          name: { type: "string" },
          serial: ref("Serial"),
        },
        type: "object",
      },
      Pet: { allOf: [ref("Base"), { required: ["id", "name", "serial"] }] },
      Serial: { readOnly: true, type: "string" },
    } satisfies Record<string, SchemaLike>;
    expect(exampleValue(ref("Pet"), schemas)).toStrictEqual({ name: "string" });
    const rules = validationSchema(ref("Pet"), schemas);
    expect(validateJson('{"name": "Rex"}', STRINGS, rules)).toStrictEqual([]);
    expect(validateJson("{}", STRINGS, rules)).toStrictEqual([
      "body.name missing",
    ]);
    // A response carries them.
    expect(
      validateJson(
        '{"name": "Rex"}',
        STRINGS,
        validationSchema(ref("Pet"), schemas, "response")
      )
    ).toStrictEqual(["body.id missing", "body.serial missing"]);
  });

  it("keeps a readOnly property readOnly where a member only bounds it", () => {
    const schema: SchemaLike = {
      allOf: [
        { properties: { id: { readOnly: true, type: "integer" } } },
        { properties: { id: { minimum: 0 } }, required: ["id"] },
      ],
      type: "object",
    };
    expect(
      validateJson("{}", STRINGS, validationSchema(schema, {}))
    ).toStrictEqual([]);
    expect(
      validateJson("{}", STRINGS, validationSchema(schema, {}, "response"))
    ).toStrictEqual(["body.id missing"]);
  });

  it("checks the items of an array beside a $ref against both item schemas", () => {
    const schemas = {
      Codes: { items: { minLength: 2, type: "string" }, type: "array" },
    } satisfies Record<string, SchemaLike>;
    const codes: SchemaLike = { ...ref("Codes"), items: { maxLength: 4 } };
    expect(resolveSchema(schemas, codes).items).toStrictEqual({
      maxLength: 4,
      minLength: 2,
      type: "string",
    });
    const rules = validationSchema(codes, schemas);
    expect(validateJson('["abc"]', STRINGS, rules)).toStrictEqual([]);
    // Object enum members match whatever order their keys come in.
    const [same, other]: SchemaLike[] = JSON.parse(
      '[{"enum": [{"b": 2, "a": 1}]}, {"enum": [{"b": 3, "a": 1}]}]'
    );
    const pair: SchemaLike = { enum: [{ a: 1, b: 2 }] };
    expect(mergeSchemas({ items: pair }, { items: same }).items).toStrictEqual(
      pair
    );
    expect(
      mergeSchemas({ items: pair }, { items: other }).items?.enum
    ).toStrictEqual([]);
    expect(validateJson('[""]', STRINGS, rules)).toStrictEqual([
      "body[0] is out of range (min length 2)",
    ]);
    expect(validateJson("[123]", STRINGS, rules)).toStrictEqual([
      "body[0] should be string, got number",
    ]);
  });

  it("keeps a schema whose anyOfs reach other models within its budget", () => {
    // Stripe's expandable fields: most properties are an id or the model.
    const schemas: Record<string, SchemaLike> = {};
    for (let model = 0; model < 30; model += 1) {
      const properties: Record<string, SchemaLike> = {};
      for (let field = 0; field < 50; field += 1) {
        properties[`p${field}`] =
          field % 3 === 1
            ? { type: "string" }
            : {
                anyOf: [
                  { maxLength: 5000, type: "string" },
                  ref(`S${(model * 7 + field) % 30}`),
                ],
              };
      }
      schemas[`S${model}`] = { properties, required: ["p1"], type: "object" };
    }
    const rules = validationSchema(ref("S0"), schemas, "response");
    expect(nodes(rules)).toBeLessThanOrEqual(1000);
    // A level short of the one that would pass it, the same everywhere: each
    // field's model is checked for itself, not for its own fields.
    expect(rules?.properties?.p48).toStrictEqual({
      anyOf: [
        { maxLength: 5000, type: "string" },
        { required: ["p1"], type: "object" },
      ],
    });
    expect(rules?.properties?.p3).toStrictEqual(rules?.properties?.p48);
    expect(exampleValue(ref("S0"), schemas, "response")).toMatchObject({
      p1: "string",
    });
  });
});

describe("authored values and hand-written mistakes", () => {
  it("leaves out only the authored values their own schema rejects", () => {
    expect(
      exampleValue(
        {
          properties: {
            age: { example: "42", type: "integer" },
            email: { example: "ada@example.com", type: "string" },
          },
          type: "object",
        },
        {}
      )
    ).toStrictEqual({ age: 0, email: "ada@example.com" });
    expect(exampleValue({ default: "20", type: "integer" }, {})).toBe(0);
    expect(
      exampleValue({ default: 5, example: "x", type: "integer" }, {})
    ).toBe(5);
    expect(exampleValue({ examples: ["x", 3], type: "integer" }, {})).toBe(3);
    expect(exampleValue({ examples: ["x"], type: "integer" }, {})).toBe(0);
    // An `examples` that isn't a list is the sampler's to ignore.
    expect(
      exampleValue(
        JSON.parse('{"example": "x", "examples": {"a": 1}, "type": "integer"}'),
        {}
      )
    ).toBe(0);
  });

  it("doesn't hold a formatted string to lengths the sampler can't write", () => {
    const login: SchemaLike = {
      properties: {
        pin: { format: "password", maxLength: 4, minLength: 4, type: "string" },
      },
      required: ["pin"],
      type: "object",
    };
    expect(exampleValue(login, {})).toStrictEqual({ pin: "pa$$word" });
    expect(validationSchema(login, {})?.properties?.pin).toStrictEqual({
      type: "string",
    });
    expect(
      validationSchema({ maxLength: 4, type: "string" }, {})
    ).toStrictEqual({ maxLength: 4, type: "string" });
  });

  it("samples and prunes Swagger 2's required: true on a property", () => {
    const schemas: Record<string, SchemaLike> = JSON.parse(
      '{"Id": {"enum": ["a"], "required": ["x"], "type": "string"}}'
    );
    const malformed: SchemaLike = JSON.parse(
      '{"properties": {"id": {"$ref": "#/components/schemas/Id", "required": true}, "name": {"required": true, "type": "string"}}, "type": "object"}'
    );
    expect(exampleValue(malformed, schemas, "response")).toStrictEqual({
      id: "a",
      name: "string",
    });
    expect(objectProperties(malformed, schemas).required.size).toBe(0);
    // Other list keywords that aren't lists check nothing.
    const odd: SchemaLike = JSON.parse(
      '{"allOf": "x", "anyOf": 5, "items": [1], "not": "y", "oneOf": 5, "properties": "z", "required": true}'
    );
    expect(validationSchema(odd, {})).toStrictEqual({});
    // Nor does a member that isn't a schema.
    expect(
      validationSchema(
        JSON.parse('{"allOf": [5], "properties": {"a": 5}, "type": "object"}'),
        {}
      )
    ).toStrictEqual({ type: "object" });
    expect(validationSchema(JSON.parse('"text"'), {})).toBeUndefined();
  });

  it("words exclusive bounds", () => {
    expect(
      constraints(
        { exclusiveMaximum: 10, exclusiveMinimum: 0 },
        EN_UI.reference
      )
    ).toStrictEqual(["greater than 0", "less than 10"]);
  });

  it("tells a body Blume built without an example from one to sample", () => {
    const schema: SchemaLike = { type: "string" };
    expect(
      mediaExample({ example: undefined, schema }, {}, "request")
    ).toBeUndefined();
    expect(mediaExample({ schema }, {}, "request")).toBe("string");
  });

  it("copies a null response example into the Markdown", () => {
    const text = operationDetails(
      { info: { title: "API", version: "1" }, openapi: "3.1.0", paths: {} },
      {
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "null" } } },
            description: "Nothing.",
          },
        },
      },
      false
    ).join("\n");
    expect(text).toContain("Response example, 200:");
    expect(text).toContain("null");
  });
});
