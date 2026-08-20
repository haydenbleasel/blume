import type {
  GraphqlDocument,
  GraphqlField,
  GraphqlInputValue,
  GraphqlOperationKind,
  GraphqlTypeRef,
} from "../../openapi/graphql.ts";
import {
  GRAPHQL_OPERATION_KINDS,
  isGraphqlOperationKind,
} from "../../openapi/graphql.ts";
import type { ApiSpecData } from "../../openapi/model.ts";
import type { SpecValue } from "./helpers.ts";
import type { PlaygroundModel } from "./request.ts";

/**
 * Build-time logic behind the GraphQL reference pages: the generated example
 * operation (a valid, bounded-depth query with a variable per argument), its
 * example variables and response, the shared playground/request model, and the
 * usage backlinks. Everything here works off the serializable
 * `GraphqlDocument` — no `graphql`-js — so none of it can drag the parser
 * into the runtime.
 */

/**
 * Stands in for the live endpoint when the config sets none, so the samples
 * and playground render a complete request the reader edits instead of a
 * URL-less fragment.
 */
export const GRAPHQL_ENDPOINT_PLACEHOLDER =
  "https://your-api.example.com/graphql";

/** How deep a generated selection set descends into nested object fields. */
const SELECTION_DEPTH = 2;

/** How deep example variables descend into nested input objects. */
const VARIABLE_DEPTH = 3;

/** Example values for the spec-defined scalars. */
const SCALAR_SAMPLES = new Map<string, SpecValue>([
  ["Boolean", true],
  ["Float", 0],
  ["ID", "id"],
  ["Int", 0],
  ["String", "string"],
]);

/** A generated example object (variables, response data). */
export interface GraphqlSampleObject {
  [key: string]: SpecValue;
}

/** One field of a generated selection set. */
export interface GraphqlSelection {
  name: string;
  /** The field's declared type (absent on the `__typename` meta field). */
  type?: GraphqlTypeRef;
  /** Sub-selection for composite fields; absent on leaves. */
  children?: GraphqlSelection[];
}

/** Whether selecting this named type requires a sub-selection. */
const isComposite = (document: GraphqlDocument, name: string): boolean => {
  const kind = document.types[name]?.kind;
  return kind === "object" || kind === "interface" || kind === "union";
};

/**
 * A valid selection set for a composite type, or undefined for leaves: every
 * scalar/enum field, plus nested composites while `depth` allows. A composite
 * with nothing selectable at this depth falls back to `__typename`, which is
 * legal on any composite — the set must never come out empty.
 */
export const selectionSet = (
  document: GraphqlDocument,
  typeName: string,
  depth: number = SELECTION_DEPTH
): GraphqlSelection[] | undefined => {
  const type = document.types[typeName];
  if (!(type && isComposite(document, typeName))) {
    return undefined;
  }
  if (type.kind === "union") {
    return [{ name: "__typename" }];
  }
  const selections: GraphqlSelection[] = [];
  for (const field of type.fields ?? []) {
    // A field that requires arguments can't ride an example selection —
    // there is nothing valid to fill them with inline.
    if (field.args.some((arg) => arg.type.display.endsWith("!"))) {
      continue;
    }
    if (isComposite(document, field.type.name)) {
      if (depth > 1) {
        selections.push({
          children: selectionSet(document, field.type.name, depth - 1),
          name: field.name,
          type: field.type,
        });
      }
      continue;
    }
    selections.push({ name: field.name, type: field.type });
  }
  return selections.length > 0 ? selections : [{ name: "__typename" }];
};

const INDENT = "  ";

const printSelections = (
  selections: GraphqlSelection[],
  level: number
): string =>
  selections
    .map((selection) => {
      const pad = INDENT.repeat(level);
      return selection.children
        ? `${pad}${selection.name} {\n${printSelections(selection.children, level + 1)}\n${pad}}`
        : `${pad}${selection.name}`;
    })
    .join("\n");

/**
 * A complete, valid example operation for one root field: one variable per
 * argument (typed off the schema), and a bounded-depth selection set over the
 * return type.
 */
export const exampleQuery = (
  document: GraphqlDocument,
  field: GraphqlField,
  kind: GraphqlOperationKind
): string => {
  const name = field.name.charAt(0).toUpperCase() + field.name.slice(1);
  const variables = field.args
    .map((arg) => `$${arg.name}: ${arg.type.display}`)
    .join(", ");
  const args = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const head = `${kind} ${name}${variables ? `(${variables})` : ""}`;
  const call = `${field.name}${args ? `(${args})` : ""}`;
  const selections = selectionSet(document, field.type.name);
  const body = selections
    ? `${INDENT}${call} {\n${printSelections(selections, 2)}\n${INDENT}}`
    : `${INDENT}${call}`;
  return `${head} {\n${body}\n}`;
};

/**
 * An example value for a type expression: scalar/enum samples at the leaves,
 * nested objects for input types while `depth` allows (a custom scalar or an
 * exhausted input depth samples as null), and list wrappers as one-element
 * arrays.
 */
const sampleForRef = (
  document: GraphqlDocument,
  ref: GraphqlTypeRef,
  depth: number
): SpecValue => {
  let named: SpecValue = SCALAR_SAMPLES.get(ref.name) ?? null;
  const type = document.types[ref.name];
  if (type?.kind === "enum") {
    named = type.enumValues?.[0]?.name ?? null;
  } else if (type?.kind === "input" && depth > 0) {
    named = Object.fromEntries(
      (type.inputFields ?? []).map((field) => [
        field.name,
        sampleForRef(document, field.type, depth - 1),
      ])
    );
  }
  return ref.display.startsWith("[") ? [named] : named;
};

/** Example `variables` for a root field's arguments; undefined when it has none. */
export const exampleVariables = (
  document: GraphqlDocument,
  field: GraphqlField
): GraphqlSampleObject | undefined =>
  field.args.length > 0
    ? Object.fromEntries(
        field.args.map((arg) => [
          arg.name,
          sampleForRef(document, arg.type, VARIABLE_DEPTH),
        ])
      )
    : undefined;

/** The example value one selection produces, mirroring the generated query. */
const responseForSelections = (
  document: GraphqlDocument,
  typeName: string,
  selections: GraphqlSelection[]
): GraphqlSampleObject => {
  const out: GraphqlSampleObject = {};
  for (const selection of selections) {
    if (selection.name === "__typename") {
      // A union's example names its first member; other composites name
      // themselves.
      out.__typename = document.types[typeName]?.possibleTypes?.[0] ?? typeName;
      continue;
    }
    // SAFETY: every non-`__typename` selection is built with its field type.
    const ref = selection.type as GraphqlTypeRef;
    if (selection.children) {
      const nested = responseForSelections(
        document,
        ref.name,
        selection.children
      );
      out[selection.name] = ref.display.startsWith("[") ? [nested] : nested;
    } else {
      out[selection.name] = sampleForRef(document, ref, 0);
    }
  }
  return out;
};

/** The example response envelope: `data` keyed by the root field. */
export interface GraphqlExampleResponse {
  data: GraphqlSampleObject;
}

/**
 * An example response envelope for the generated query — the same selection
 * set, so the response shows exactly the fields the query asks for.
 */
export const exampleResponse = (
  document: GraphqlDocument,
  field: GraphqlField
): GraphqlExampleResponse => {
  const selections = selectionSet(document, field.type.name);
  const data: GraphqlSampleObject = {};
  if (selections) {
    const value = responseForSelections(document, field.type.name, selections);
    data[field.name] = field.type.display.startsWith("[") ? [value] : value;
  } else {
    data[field.name] = sampleForRef(document, field.type, 0);
  }
  return { data };
};

/**
 * The playground/request model for one GraphQL operation: a plain POST whose
 * JSON body carries the query and variables. Reusing `PlaygroundModel` means
 * the OpenAPI playground UI, its client module, and `buildRequest` all work
 * unchanged — the samples show byte-for-byte what the Send button transmits.
 */
export const graphqlPlaygroundModel = (
  spec: ApiSpecData,
  query: string,
  variables?: GraphqlSampleObject
): PlaygroundModel => ({
  auth: [],
  authOptional: true,
  body: {
    contentType: "application/json",
    example: JSON.stringify(
      variables === undefined ? { query } : { query, variables },
      null,
      2
    ),
    schema: {
      properties: { query: { type: "string" }, variables: { type: "object" } },
      required: ["query"],
      type: "object",
    },
  },
  method: "POST",
  params: [],
  path: "",
  servers: [spec.endpoint ?? GRAPHQL_ENDPOINT_PLACEHOLDER],
});

/**
 * Routes for every paged member of a spec, keyed by its schema name — the
 * link table type references resolve against (a name with no page, like a
 * built-in scalar, renders as plain text).
 */
export const graphqlRoutes = (spec: ApiSpecData): Map<string, string> => {
  const routes = new Map<string, string>();
  for (const ref of Object.values(spec.operations)) {
    // Type pages only: a root field named like a type must not shadow it.
    if (ref.operationId !== undefined && !isGraphqlOperationKind(ref.method)) {
      routes.set(ref.operationId, ref.route);
    }
  }
  return routes;
};

/** Where one named type is used across the schema. */
export interface GraphqlUsage {
  /** Root fields whose return type or arguments mention the type. */
  operations: { kind: GraphqlOperationKind; name: string }[];
  /** Named types whose fields, arguments, or members mention the type. */
  types: string[];
}

/** Whether a field's own type or any of its argument types names `target`. */
const fieldMentions = (field: GraphqlField, target: string): boolean =>
  field.type.name === target ||
  field.args.some((arg) => arg.type.name === target);

/**
 * Usage backlinks for one type page: the operations that return or accept it,
 * and the other types that reference it (fields, input fields, union
 * membership). Root types are folded into `operations` — their fields are the
 * operation pages.
 */
export const graphqlUsage = (
  document: GraphqlDocument,
  target: string
): GraphqlUsage => {
  const operations: GraphqlUsage["operations"] = [];
  const rootNames = new Map<string, GraphqlOperationKind>();
  for (const kind of GRAPHQL_OPERATION_KINDS) {
    const name = document.roots[kind];
    if (name !== undefined) {
      rootNames.set(name, kind);
    }
  }
  const types: string[] = [];
  for (const type of Object.values(document.types)) {
    if (type.name === target) {
      continue;
    }
    const rootKind = rootNames.get(type.name);
    if (rootKind !== undefined) {
      for (const field of type.fields ?? []) {
        if (fieldMentions(field, target)) {
          operations.push({ kind: rootKind, name: field.name });
        }
      }
      continue;
    }
    const mentioned =
      (type.fields ?? []).some((field) => fieldMentions(field, target)) ||
      (type.inputFields ?? []).some((input) => input.type.name === target) ||
      (type.kind === "union" && (type.possibleTypes ?? []).includes(target));
    if (mentioned) {
      types.push(type.name);
    }
  }
  return { operations, types };
};

/** The row shapes the fields table renders: output fields or input values. */
export type GraphqlFieldRow = GraphqlField | GraphqlInputValue;

/** Narrow a table row to an output field (with arguments). */
export const isOutputField = (row: GraphqlFieldRow): row is GraphqlField =>
  "args" in row;
