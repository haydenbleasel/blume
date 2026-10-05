import { describe, expect, it } from "bun:test";

import {
  objectProperties,
  resolveSchema,
  soleAllOfMember,
  typeLabel,
} from "../src/components/openapi/helpers.ts";
import type { SchemaLike } from "../src/components/openapi/helpers.ts";
import { operationModel } from "../src/components/openapi/operation-model.ts";
import {
  rowExpands,
  schemaTree,
} from "../src/components/openapi/schema-tree.ts";
import type { SchemaNode } from "../src/components/openapi/schema-tree.ts";

/**
 * An `allOf` with one member wraps a `$ref` so the property can carry
 * keywords a 3.0 `$ref` can't: drf-spectacular writes every enum and nested
 * serializer field this way, and the 3.1 upgrade keeps the wrapper whenever
 * it carries a `description`, `readOnly`, or `default`. The wrapper should
 * read exactly like its member.
 */

const ref = (name: string): SchemaLike => ({
  $ref: `#/components/schemas/${name}`,
});

const SCHEMAS = {
  Category: {
    properties: {
      name: { type: "string" },
      // A nested serializer pointing back at its own model.
      parent: { allOf: [ref("Category")], readOnly: true },
      status: {
        allOf: [ref("StatusEnum")],
        description: "* `draft` - Draft\n* `live` - Live",
      },
    },
    type: "object",
  },
  PriorityEnum: { enum: [1, 2, 3], type: "integer" },
  StatusEnum: {
    description: "Where the post is.",
    enum: ["draft", "live"],
    type: "string",
  },
} satisfies Record<string, SchemaLike>;

const rows = (node: SchemaNode) => {
  if (node.kind !== "properties") {
    throw new Error(`expected a properties node, got ${node.kind}`);
  }
  return new Map(node.rows.map((row) => [row.name, row]));
};

describe("a single-member allOf", () => {
  it("labels like its member, not as an object", () => {
    expect(typeLabel({ allOf: [ref("StatusEnum")], description: "x" })).toBe(
      "StatusEnum"
    );
    expect(typeLabel({ allOf: [{ format: "uuid", type: "string" }] })).toBe(
      "string<uuid>"
    );
    // A real composition, or a wrapper with fields of its own, stays an object.
    expect(typeLabel({ allOf: [ref("A"), ref("B")] })).toBe("object");
    expect(
      typeLabel({
        allOf: [ref("A")],
        properties: { extra: { type: "string" } },
      })
    ).toBe("object");
  });

  it("resolves to its member with its own keywords on top", () => {
    const status = resolveSchema(SCHEMAS, SCHEMAS.Category.properties.status);
    expect(status.enum).toStrictEqual(["draft", "live"]);
    expect(status.type).toBe("string");
    // The wrapper's description is about this field, so it wins.
    expect(status.description).toBe("* `draft` - Draft\n* `live` - Live");
    expect(status.allOf).toBeUndefined();
    // Without one, the member's description shows.
    expect(
      resolveSchema(SCHEMAS, { allOf: [ref("StatusEnum")] }).description
    ).toBe("Where the post is.");
    expect(soleAllOfMember({ allOf: [ref("A")], oneOf: [] })).toBeUndefined();
    expect(soleAllOfMember({ allOf: [ref("A")], anyOf: [] })).toBeUndefined();
  });

  it("plans the table like a $ref, so a self-reference stops", () => {
    // Before, the wrapper hid the circle and planning overflowed the stack.
    const tree = rows(schemaTree(ref("Category"), SCHEMAS));
    // Like a direct self-`$ref`, the row names its model with no disclosure.
    const parent = tree.get("parent");
    expect(parent?.children).toBeUndefined();
    expect(typeLabel(parent?.schema ?? {})).toBe("Category");
    // An enum has nothing to disclose; its row shows the allowed values.
    const status = tree.get("status");
    expect(status?.children).toBeUndefined();

    // Beside the root, the wrapped model expands as a named table.
    const wrapped = schemaTree(
      {
        properties: { post: { allOf: [ref("Category")], readOnly: true } },
        type: "object",
      },
      SCHEMAS
    );
    const post = rows(wrapped).get("post");
    expect(post && rowExpands(post)).toBe(true);
    expect([...rows(post?.children?.node ?? wrapped).keys()]).toStrictEqual([
      "name",
      "parent",
      "status",
    ]);
  });

  it("still merges a model that wraps a single parent", () => {
    const { properties } = objectProperties(
      { allOf: [ref("Category")] },
      SCHEMAS
    );
    expect(properties.map(([name]) => name)).toStrictEqual([
      "name",
      "parent",
      "status",
    ]);
  });

  it("gives Try it the member's type and allowed values", () => {
    const model = operationModel({
      method: "post",
      parameters: [
        {
          in: "query",
          name: "status",
          schema: { allOf: [ref("StatusEnum")], default: "draft" },
        },
      ],
      path: "/posts",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: { priority: { allOf: [ref("PriorityEnum")] } },
              type: "object",
            },
          },
        },
      },
      schemas: SCHEMAS,
      security: { alternatives: [], optional: false },
      servers: [{ url: "https://api.test" }],
    });
    expect(model.params[0]?.enum).toStrictEqual(["draft", "live"]);
    expect(model.body?.fields?.[0]).toMatchObject({
      enum: ["1", "2", "3"],
      type: "integer",
    });
  });
});
