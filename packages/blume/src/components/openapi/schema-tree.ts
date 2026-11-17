import {
  declaresType,
  objectProperties,
  refName,
  resolveSchema,
  soleAllOfMember,
  typeLabel,
} from "./helpers.ts";
import type { SchemaLike, SpecValue } from "./helpers.ts";

/**
 * The expansion plan behind the schema tables (`SchemaTable.astro` and
 * `SchemaProperty.astro`). Every nested object is server-rendered in full
 * inside a collapsed `<details>`, so the plan is the page's weight: expanding
 * each named schema wherever it appears — stopping only at a model nested in
 * itself — grows exponentially with cross-references (twelve schemas that
 * each reference four others render tens of thousands of nested tables for
 * one request body).
 *
 * So a named schema expands wherever it appears in the first
 * {@link REPEAT_DEPTH} named levels, and deeper than that only where it
 * appears first in the tree, breadth-first; a later mention shows its name
 * alone. Beyond the first levels each named schema expands at most once, so
 * the tree stays proportional to the spec instead of to the number of paths
 * through it, while the shallow nesting typical specs use — `billing` and
 * `shipping` both an `Address` — renders exactly as before.
 */

/**
 * Named-schema nesting depth (the root being 0) up to which a named schema
 * expands at every mention, even one already expanded elsewhere in the tree.
 */
export const REPEAT_DEPTH = 2;

/** A place in the tree a node is planned into; filled in breadth-first. */
export interface SchemaSlot {
  node: SchemaNode;
}

/** One property row of an object table. */
export interface SchemaRow {
  name: string;
  required: boolean;
  schema: SchemaLike;
  /** The row's disclosure contents; absent when the row has nothing to show. */
  children?: SchemaSlot;
}

/** What one schema table renders. */
export type SchemaNode =
  /** A named schema nested inside itself. */
  | { kind: "circular"; name: string }
  /** A named schema expanded elsewhere in this tree: its name only. */
  | { kind: "named"; name: string }
  /** An array; `schema` holds the limits its table lists (`minItems`). */
  | {
      kind: "array";
      itemsLabel: string;
      items?: SchemaSlot;
      schema: SchemaLike;
    }
  | {
      kind: "branches";
      /** The schema's `oneOf`, then its `anyOf`: a value satisfies both. */
      groups: BranchGroup[];
      /** The schema itself, whose own limits bind every variant. */
      schema: SchemaLike;
      /**
       * Properties the schema declares beside its `oneOf`/`anyOf`, which
       * every variant shares; absent when it declares none.
       */
      rows?: SchemaRow[];
    }
  | { kind: "properties"; rows: SchemaRow[] }
  /** A value with no fields; `schema` holds the limits its table lists. */
  | { kind: "type"; label: string; schema: SchemaLike };

/** One `oneOf` or `anyOf` of a schema and its variants. */
export interface BranchGroup {
  /** Which combinator: worded in the page's language by `SchemaTable`. */
  label: "One of" | "Any of";
  /**
   * Each variant, labeled by its type; `""` when it declares none, like a
   * variant that only requires some of the schema's properties.
   */
  branches: { label: string; slot: SchemaSlot }[];
}

/** The row an object's `additionalProperties` schema renders as. */
export const ADDITIONAL_PROPERTIES = "[key: string]";

const isString = (value: SpecValue): value is string =>
  typeof value === "string";

/** An `additionalProperties` that is a schema, not `true` or `false`. */
const isSchema = (
  value: boolean | SchemaLike | undefined
): value is SchemaLike => typeof value === "object";

/**
 * The `$ref` a schema stands for: its own, or its member's when it is a
 * single-member `allOf` wrapper, which plans (and stops at a circle) the same.
 */
const refOf = (schema: SchemaLike): string | undefined => {
  const ref = schema.$ref ?? soleAllOfMember(schema)?.$ref;
  return isString(ref) ? ref : undefined;
};

const typesOf = (schema: SchemaLike): (string | undefined)[] =>
  Array.isArray(schema.type) ? schema.type : [schema.type];

/**
 * Whether a schema has nested fields a row can disclose: its own, or those of
 * the values of a map.
 */
const hasNestedFields = (candidate: SchemaLike): boolean => {
  const values = candidate.additionalProperties;
  return Boolean(
    candidate.properties ||
    candidate.allOf ||
    candidate.oneOf ||
    candidate.anyOf ||
    isString(candidate.$ref) ||
    (isSchema(values) && hasNestedFields(values))
  );
};

/** A named schema waiting for its breadth-first turn. */
interface PendingRef {
  ancestors: string[];
  name: string;
  schema: SchemaLike;
  slot: SchemaSlot;
}

/**
 * Which way a schema's data travels, when its table has one: a request body
 * leaves out the `readOnly` fields the server generates, and a response the
 * `writeOnly` ones it never returns, as the examples beside them do.
 */
export type SchemaDirection = "request" | "response";

/**
 * Plan the table tree for one schema (a request body, a response, a payload).
 * With a `direction`, every table in the tree leaves out the fields that
 * don't travel that way.
 */
export const schemaTree = (
  root: SchemaLike,
  schemas: Record<string, SchemaLike>,
  direction?: SchemaDirection
): SchemaNode => {
  const queue: PendingRef[] = [];
  const expanded = new Set<string>();
  const omitted = direction === "request" ? "readOnly" : "writeOnly";

  /** Whether a property stays out of this tree's tables. */
  const hidden = (property: SchemaLike): boolean =>
    direction !== undefined &&
    (property[omitted] === true ||
      resolveSchema(schemas, property)[omitted] === true);

  /**
   * A table for `schema`, where `ancestors` are the named schemas already
   * open above it. A `$ref` waits in the queue, so every mention at one depth
   * is planned before any deeper one; `resolved` plans a dequeued schema's
   * own body instead.
   */
  const table = (
    schema: SchemaLike,
    ancestors: string[],
    resolved = false
  ): SchemaSlot => {
    const ref = resolved ? undefined : refOf(schema);
    if (ref) {
      const name = refName(ref);
      if (ancestors.includes(name)) {
        return { node: { kind: "circular", name } };
      }
      const slot: SchemaSlot = { node: { kind: "named", name } };
      queue.push({ ancestors, name, schema, slot });
      return slot;
    }
    if (typesOf(schema).includes("array")) {
      // Items stay unresolved, so a self-referential item `$ref` is still
      // recognized as the circle it is.
      const { items } = schema;
      return {
        node: items
          ? {
              items: table(items, ancestors),
              itemsLabel: typeLabel(items),
              kind: "array",
              schema,
            }
          : { itemsLabel: typeLabel({}), kind: "array", schema },
      };
    }
    // A row discloses nested structure — never a model inside itself.
    const rowChildren = (property: SchemaLike): SchemaSlot | undefined => {
      const propertyRef = refOf(property);
      if (propertyRef && ancestors.includes(refName(propertyRef))) {
        return undefined;
      }
      const target = resolveSchema(schemas, property);
      const items = typesOf(target).includes("array")
        ? resolveSchema(schemas, target.items)
        : null;
      return hasNestedFields(target) || (items && hasNestedFields(items))
        ? table(property, ancestors)
        : undefined;
    };
    const { properties, required } = objectProperties(schema, schemas);
    // A map's values render as one more row, after the named properties.
    const values = schema.additionalProperties;
    const listed: [string, SchemaLike][] = isSchema(values)
      ? [...properties, [ADDITIONAL_PROPERTIES, values]]
      : properties;
    const rows: SchemaRow[] = listed
      .filter(([, property]) => !hidden(property))
      .map(([name, property]) => ({
        children: rowChildren(property),
        name,
        required: required.has(name),
        schema: property,
      }));
    /**
     * A variant as its table shows it. One that declares no type of its own
     * narrows this schema, so it has this schema's type, and the properties
     * of this schema it requires are rows of its table: `{ required: [card] }`
     * lists `card` as required rather than reading as `any`.
     */
    const variant = (branch: SchemaLike): SchemaLike => {
      if (refOf(branch)) {
        return branch;
      }
      const shared = new Map(properties);
      const borrowed = (branch.required ?? []).flatMap((name) => {
        const property = shared.get(name);
        return property && !branch.properties?.[name]
          ? [[name, property] as const]
          : [];
      });
      const shown: SchemaLike = { ...branch };
      if (!declaresType(branch) && schema.type) {
        shown.type = schema.type;
      }
      if (borrowed.length > 0) {
        shown.properties = {
          ...Object.fromEntries(borrowed),
          ...branch.properties,
        };
      }
      return shown;
    };
    // Shared properties beside a `oneOf`/`anyOf` (`amount` and `currency`
    // next to `Card | BankAccount`) render above the variants, planned first
    // as they read first. A schema with both keeps both: a value satisfies
    // its `oneOf` and its `anyOf`.
    const groups: BranchGroup[] = (
      [
        ["One of", schema.oneOf],
        ["Any of", schema.anyOf],
      ] as const
    ).flatMap(([label, branches]) =>
      branches
        ? [
            {
              // An unlabeled variant renders as its position ("Option 2"),
              // worded in the page's language by `SchemaTable`.
              branches: branches.map((branch) => ({
                label: declaresType(branch) ? typeLabel(branch) : "",
                slot: table(variant(branch), ancestors),
              })),
              label,
            },
          ]
        : []
    );
    if (groups.length > 0) {
      const node: Extract<SchemaNode, { kind: "branches" }> = {
        groups,
        kind: "branches",
        schema,
      };
      if (rows.length > 0) {
        node.rows = rows;
      }
      return { node };
    }
    if (rows.length > 0) {
      return { node: { kind: "properties", rows } };
    }
    return { node: { kind: "type", label: typeLabel(schema), schema } };
  };

  const tree = table(root, []);
  // The queue grows while it drains, in depth order: every mention at one
  // named depth is queued before the first one at the next.
  for (const pending of queue) {
    const depth = pending.ancestors.length;
    if (depth > REPEAT_DEPTH && expanded.has(pending.name)) {
      continue;
    }
    expanded.add(pending.name);
    pending.slot.node = table(
      resolveSchema(schemas, pending.schema),
      [...pending.ancestors, pending.name],
      true
    ).node;
  }
  return tree.node;
};

/**
 * Whether a row gets a disclosure: it has nested structure, and that structure
 * isn't just the name of a schema expanded elsewhere (directly, or as the
 * items of an array).
 */
export const rowExpands = (row: SchemaRow): boolean => {
  const node = row.children?.node;
  if (!node || node.kind === "named") {
    return false;
  }
  return !(node.kind === "array" && node.items?.node.kind === "named");
};
