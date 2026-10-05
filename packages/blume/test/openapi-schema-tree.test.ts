import { describe, expect, it } from "bun:test";

import type { SchemaLike } from "../src/components/openapi/helpers.ts";
import {
  REPEAT_DEPTH,
  rowExpands,
  schemaTree,
} from "../src/components/openapi/schema-tree.ts";
import type {
  SchemaNode,
  SchemaRow,
} from "../src/components/openapi/schema-tree.ts";

/**
 * The schema tables server-render every nested object, so the plan in
 * `schema-tree.ts` is what a page weighs. These pin that a densely
 * cross-referenced spec stays bounded while ordinary nesting — shared models
 * side by side, self-references, arrays, unions — renders as it always has.
 */

const ref = (name: string): SchemaLike => ({
  $ref: `#/components/schemas/${name}`,
});

/** Every property row the page would render, following open disclosures. */
const renderedRows = (node: SchemaNode): number => {
  switch (node.kind) {
    case "array": {
      return node.items ? renderedRows(node.items.node) : 0;
    }
    case "branches": {
      return node.branches.reduce(
        (total, branch) => total + renderedRows(branch.slot.node),
        0
      );
    }
    case "properties": {
      return node.rows.reduce(
        (total, row) =>
          total +
          1 +
          (rowExpands(row) && row.children
            ? renderedRows(row.children.node)
            : 0),
        0
      );
    }
    default: {
      return 0;
    }
  }
};

/** The rows of a properties node, by name. */
const rowsOf = (node: SchemaNode | undefined): Map<string, SchemaRow> => {
  if (node?.kind !== "properties") {
    throw new Error(`expected a properties node, got ${node?.kind}`);
  }
  return new Map(node.rows.map((row) => [row.name, row]));
};

const childOf = (row: SchemaRow | undefined): SchemaNode | undefined =>
  row?.children?.node;

describe("schemaTree", () => {
  it("stays bounded for a densely cross-referenced spec", () => {
    // Sixteen models that each reference four others: expanding every
    // mention (cut only at a model inside itself) rendered 684,170 rows for
    // this one body.
    const count = 16;
    const links = [1, 2, 3, 4];
    const schemas = Object.fromEntries(
      Array.from({ length: count }, (_, index): [string, SchemaLike] => [
        `S${index}`,
        {
          properties: Object.fromEntries([
            ["id", { type: "string" }],
            ...links.map((link): [string, SchemaLike] => [
              `link${link}`,
              ref(`S${(index * 5 + link * 7) % count}`),
            ]),
          ]),
          type: "object",
        },
      ])
    );
    const rows = renderedRows(schemaTree(ref("S0"), schemas));
    // At most every table in the free top levels (1 + 4 + 16 of them, five
    // rows each), plus one more expansion per model below them.
    expect(REPEAT_DEPTH).toBe(2);
    expect(rows).toBeLessThanOrEqual((1 + 4 + 16 + count) * 5);
    expect(rows).toBeGreaterThan(5);
  });

  it("expands a shared model everywhere in the shallow levels", () => {
    const schemas = {
      Address: {
        properties: { city: { type: "string" } },
        type: "object",
      },
      Customer: {
        properties: { billing: ref("Address"), shipping: ref("Address") },
        type: "object",
      },
    } satisfies Record<string, SchemaLike>;
    const top = rowsOf(schemaTree(ref("Customer"), schemas));
    for (const name of ["billing", "shipping"]) {
      const row = top.get(name);
      expect(row && rowExpands(row)).toBe(true);
      expect(rowsOf(childOf(row)).has("city")).toBe(true);
    }
  });

  it("names a model already expanded elsewhere once past the shallow levels", () => {
    // Money sits at named depth 1 under `total` and again at depth 3 under
    // items → product → price: the deep mention shows its name only.
    const schemas = {
      LineItem: { properties: { product: ref("Product") }, type: "object" },
      Money: {
        properties: { amount: { type: "integer" } },
        type: "object",
      },
      Order: {
        properties: {
          items: { items: ref("LineItem"), type: "array" },
          total: ref("Money"),
        },
        type: "object",
      },
      Product: { properties: { price: ref("Money") }, type: "object" },
    } satisfies Record<string, SchemaLike>;
    const order = rowsOf(schemaTree(ref("Order"), schemas));
    expect(rowsOf(childOf(order.get("total"))).has("amount")).toBe(true);

    const items = childOf(order.get("items"));
    expect(items?.kind).toBe("array");
    const lineItem = items?.kind === "array" ? items.items?.node : undefined;
    const product = childOf(rowsOf(lineItem).get("product"));
    const price = rowsOf(product).get("price");
    expect(childOf(price)).toStrictEqual({ kind: "named", name: "Money" });
    expect(price && rowExpands(price)).toBe(false);
  });

  it("names an array of an already-expanded model without a disclosure", () => {
    const deep = (next: string): SchemaLike => ({
      properties: { next: ref(next) },
      type: "object",
    });
    const schemas = {
      A: {
        properties: { d: ref("D"), next: ref("B") },
        type: "object",
      },
      B: deep("C"),
      C: {
        properties: { list: { items: ref("D"), type: "array" } },
        type: "object",
      },
      D: { properties: { id: { type: "string" } }, type: "object" },
    } satisfies Record<string, SchemaLike>;
    const a = rowsOf(schemaTree(ref("A"), schemas));
    const c = childOf(rowsOf(childOf(a.get("next"))).get("next"));
    const list = rowsOf(c).get("list");
    expect(childOf(list)?.kind).toBe("array");
    expect(list && rowExpands(list)).toBe(false);
  });

  it("marks a model nested in itself as circular", () => {
    const schemas = {
      Category: {
        properties: {
          children: { items: ref("Category"), type: "array" },
          name: { type: "string" },
          parent: ref("Category"),
        },
        type: "object",
      },
    } satisfies Record<string, SchemaLike>;
    const category = rowsOf(schemaTree(ref("Category"), schemas));
    // A direct self-reference gets no disclosure at all.
    expect(category.get("parent")?.children).toBeUndefined();
    // Through an array it opens onto the circular note, as before.
    const children = category.get("children");
    expect(children && rowExpands(children)).toBe(true);
    const array = childOf(children);
    expect(
      array?.kind === "array" ? array.items?.node : undefined
    ).toStrictEqual({ kind: "circular", name: "Category" });
  });

  it("plans unions, bare arrays, unresolved refs, and scalars", () => {
    const schemas = {
      Cat: { properties: { meow: { type: "boolean" } }, type: "object" },
    } satisfies Record<string, SchemaLike>;
    const union = schemaTree(
      { oneOf: [ref("Cat"), { type: "string" }] },
      schemas
    );
    expect(union.kind === "branches" && union.label).toBe("One of");
    expect(
      union.kind === "branches" &&
        union.branches.map((branch) => [branch.label, branch.slot.node.kind])
    ).toStrictEqual([
      ["Cat", "properties"],
      ["string", "type"],
    ]);
    const anyOf = schemaTree({ anyOf: [{}, { type: "string" }] }, schemas);
    expect(anyOf.kind === "branches" && anyOf.label).toBe("Any of");
    expect(
      anyOf.kind === "branches" && anyOf.branches.map((branch) => branch.label)
    ).toStrictEqual(["any", "string"]);

    expect(schemaTree({ type: "array" }, schemas)).toStrictEqual({
      itemsLabel: "any",
      kind: "array",
    });
    expect(schemaTree(ref("Missing"), schemas)).toStrictEqual({
      kind: "type",
      label: "Missing",
    });
    expect(
      schemaTree({ format: "uuid", type: "string" }, schemas)
    ).toStrictEqual({ kind: "type", label: "string<uuid>" });
  });

  it("gives an inline object row a disclosure and a scalar row none", () => {
    const rows = rowsOf(
      schemaTree(
        {
          properties: {
            meta: {
              properties: { tag: { type: "string" } },
              type: "object",
            },
            name: { type: "string" },
            tags: { items: { type: "string" }, type: "array" },
          },
          required: ["name"],
          type: "object",
        },
        {}
      )
    );
    expect(rows.get("name")?.required).toBe(true);
    expect(rows.get("name")?.children).toBeUndefined();
    expect(rows.get("tags")?.children).toBeUndefined();
    const meta = rows.get("meta");
    expect(meta && rowExpands(meta)).toBe(true);
    expect(rowsOf(childOf(meta)).has("tag")).toBe(true);
  });

  it("leaves readOnly fields out of a request and writeOnly out of a response", () => {
    const schemas = {
      Id: { readOnly: true, type: "string" },
      User: {
        properties: {
          createdAt: { readOnly: true, type: "string" },
          id: ref("Id"),
          name: { type: "string" },
          owner: { allOf: [ref("Owner")], readOnly: true },
          password: { type: "string", writeOnly: true },
          profile: {
            properties: {
              bio: { type: "string" },
              views: { readOnly: true, type: "integer" },
            },
            type: "object",
          },
        },
        required: ["id", "name"],
        type: "object",
      },
    } satisfies Record<string, SchemaLike>;
    const names = (node: SchemaNode | undefined) => [...rowsOf(node).keys()];

    const request = rowsOf(schemaTree(ref("User"), schemas, "request"));
    expect([...request.keys()]).toStrictEqual(["name", "password", "profile"]);
    // Nested tables follow the same direction.
    expect(names(childOf(request.get("profile")))).toStrictEqual(["bio"]);

    const response = schemaTree(ref("User"), schemas, "response");
    expect(names(response)).toStrictEqual([
      "createdAt",
      "id",
      "name",
      "owner",
      "profile",
    ]);

    // A table with no direction (an AsyncAPI payload) shows every field.
    expect(names(schemaTree(ref("User"), schemas))).toHaveLength(6);
  });
});
