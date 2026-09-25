import { describe, expect, it } from "bun:test";

import type { SchemaLike } from "../src/components/openapi/helpers.ts";
import { schemaTree } from "../src/components/openapi/schema-tree.ts";

/**
 * A `oneOf`/`anyOf` beside `properties` (or an `allOf`) describes fields every
 * variant shares plus the variants themselves; the table must show both, not
 * the variant list alone.
 */

const SCHEMAS = {
  Bank: { properties: { iban: { type: "string" } }, type: "object" },
  Card: { properties: { number: { type: "string" } }, type: "object" },
} satisfies Record<string, SchemaLike>;

describe("schemaTree unions with shared properties", () => {
  it("plans the shared properties above the variants", () => {
    const node = schemaTree(
      {
        oneOf: [
          { $ref: "#/components/schemas/Card" },
          { $ref: "#/components/schemas/Bank" },
        ],
        properties: {
          amount: { type: "integer" },
          currency: { type: "string" },
        },
        required: ["amount"],
        type: "object",
      },
      SCHEMAS
    );
    if (node.kind !== "branches") {
      throw new Error(`expected a branches node, got ${node.kind}`);
    }
    expect(node.label).toBe("One of");
    expect(node.branches.map((branch) => branch.label)).toStrictEqual([
      "Card",
      "Bank",
    ]);
    expect(
      node.rows?.map((row) => [row.name, row.required, row.children])
    ).toStrictEqual([
      ["amount", true, undefined],
      ["currency", false, undefined],
    ]);
  });

  it("merges allOf fields into the shared rows of an anyOf", () => {
    const node = schemaTree(
      {
        allOf: [{ properties: { id: { type: "string" } } }],
        anyOf: [{ type: "string" }, { type: "integer" }],
      },
      SCHEMAS
    );
    expect(node.kind === "branches" && node.label).toBe("Any of");
    expect(
      node.kind === "branches" && node.rows?.map((row) => row.name)
    ).toStrictEqual(["id"]);
  });

  it("leaves rows out of a plain union", () => {
    const node = schemaTree({ oneOf: [{ type: "string" }] }, SCHEMAS);
    expect(node).toStrictEqual({
      branches: [
        { label: "string", slot: { node: { kind: "type", label: "string" } } },
      ],
      kind: "branches",
      label: "One of",
    });
  });
});
