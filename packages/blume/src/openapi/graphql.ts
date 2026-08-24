import type { ApiOperationRef, ExtractedOperations } from "./model.ts";
import { operationCollector, operationKey } from "./model.ts";

/**
 * Blume's own GraphQL model — the third front-end of the API reference
 * pipeline. Schemas are lowered to this JSON-serializable document at parse
 * time (see `buildGraphqlDocument` in `graphql-build.ts`, kept separate so
 * `graphql`-js stays out of this module's import graph), so the components
 * render entirely from plain data, mirroring how `model.ts` keeps OpenAPI
 * documents serializable. Browser-safe: no Node imports (the components
 * import from here).
 */

/** The three GraphQL operation kinds, each a sidebar group of root fields. */
export const GRAPHQL_OPERATION_KINDS = [
  "query",
  "mutation",
  "subscription",
] as const;

export type GraphqlOperationKind = (typeof GRAPHQL_OPERATION_KINDS)[number];

/** The named-type kinds that get reference pages, in sidebar-group order. */
export const GRAPHQL_TYPE_KINDS = [
  "object",
  "input",
  "enum",
  "interface",
  "union",
  "scalar",
] as const;

export type GraphqlTypeKind = (typeof GRAPHQL_TYPE_KINDS)[number];

/** Everything a GraphQL operation ref's `method` can carry. */
export type GraphqlMember = GraphqlOperationKind | GraphqlTypeKind;

/** Sidebar/overview group label for each member kind. */
export const GRAPHQL_GROUP_LABELS = {
  enum: "Enums",
  input: "Input Objects",
  interface: "Interfaces",
  mutation: "Mutations",
  object: "Objects",
  query: "Queries",
  scalar: "Scalars",
  subscription: "Subscriptions",
  union: "Unions",
} satisfies Record<GraphqlMember, string>;

/**
 * A type expression as it appears in the schema: the rendered display form
 * (`[String!]!`) plus the named type at its core (`String`), so components can
 * print the exact wrapper shape and still link to the named type's page.
 */
export interface GraphqlTypeRef {
  display: string;
  name: string;
}

/** An argument or input-object field. */
export interface GraphqlInputValue {
  name: string;
  description: string;
  type: GraphqlTypeRef;
  /** Default value printed as a GraphQL literal (`10`, `"asc"`, `[1, 2]`). */
  default?: string;
  deprecationReason?: string;
}

/** An output field of an object or interface type (root fields included). */
export interface GraphqlField {
  name: string;
  description: string;
  type: GraphqlTypeRef;
  args: GraphqlInputValue[];
  deprecationReason?: string;
}

/** One member of an enum type. */
export interface GraphqlEnumValue {
  name: string;
  description: string;
  deprecationReason?: string;
}

/** One named type of the schema, flattened to the fields the reference renders. */
export interface GraphqlTypeDef {
  name: string;
  kind: GraphqlTypeKind;
  description: string;
  /** Output fields (object and interface types). */
  fields?: GraphqlField[];
  /** Input fields (input object types). */
  inputFields?: GraphqlInputValue[];
  /** Members (enum types). */
  enumValues?: GraphqlEnumValue[];
  /** Member type names (unions) or implementing object types (interfaces). */
  possibleTypes?: string[];
  /** Interfaces this object/interface type implements. */
  interfaces?: string[];
  /** `specifiedBy` URL (custom scalars). */
  specifiedByUrl?: string;
  /**
   * A spec-defined scalar (`String`, `Int`, …): kept for type refs to resolve
   * against, but never given a reference page of its own.
   */
  builtIn?: boolean;
}

/** A normalized GraphQL schema, lowered to serializable data at parse time. */
export interface GraphqlDocument {
  /** Mirrors the OpenAPI `info` block so `source.ts` reads one shape. */
  info?: { title?: string; version?: string; description?: string };
  /** Root operation type names (`Query`, `Mutation`, `Subscription`). */
  roots: Partial<Record<GraphqlOperationKind, string>>;
  /** Named types by name, spec-defined scalars included, introspection types excluded. */
  types: Record<string, GraphqlTypeDef>;
}

/** Whether an operation ref's method is a root-field kind (vs a type page). */
export const isGraphqlOperationKind = (
  method: string
): method is GraphqlOperationKind =>
  GRAPHQL_OPERATION_KINDS.some((kind) => kind === method);

// Deterministic name order for type pages, independent of schema declaration
// order and of the platform's collation (localeCompare varies across ICU
// builds; codepoint order does not).
const byName = (a: GraphqlTypeDef, b: GraphqlTypeDef): number =>
  a.name < b.name ? -1 : 1;

/**
 * Flatten a GraphQL document into a route-mapped page list and its ordered
 * groups — the GraphQL counterpart of `extractOperations` in `model.ts`, built
 * on the same `operationCollector`. Root fields become operation pages grouped
 * as Queries/Mutations/Subscriptions; every other named type becomes a type
 * page grouped by kind (Objects, Input Objects, …). Spec-defined scalars and
 * the root types themselves get no page — the roots' fields ARE the operation
 * pages, and `String`/`Int`/… document nothing.
 */
export const extractGraphqlOperations = (
  document: GraphqlDocument,
  baseRoute: string
): ExtractedOperations => {
  const collector = operationCollector(baseRoute, new Map());
  const rootNames = new Set(Object.values(document.roots));

  for (const kind of GRAPHQL_OPERATION_KINDS) {
    const rootName = document.roots[kind];
    const root = rootName === undefined ? undefined : document.types[rootName];
    for (const field of root?.fields ?? []) {
      collector.add({
        deprecated: field.deprecationReason !== undefined,
        description: field.description,
        // `operationKey` slug rules keep GraphQL URLs consistent with the
        // other spec kinds; its fallback covers a name that slugifies empty.
        key: operationKey(kind, field.name, field.name),
        method: kind,
        operationId: field.name,
        path: field.name,
        summary: "",
        tag: GRAPHQL_GROUP_LABELS[kind],
      });
    }
  }

  for (const kind of GRAPHQL_TYPE_KINDS) {
    const members = Object.values(document.types)
      .filter(
        (type) =>
          type.kind === kind && !(type.builtIn || rootNames.has(type.name))
      )
      .toSorted(byName);
    for (const type of members) {
      collector.add({
        deprecated: false,
        description: type.description,
        key: operationKey(kind, type.name, type.name),
        method: kind,
        operationId: type.name,
        path: type.name,
        summary: "",
        tag: GRAPHQL_GROUP_LABELS[kind],
      });
    }
  }

  return { ...collector.finish(), warnings: [] };
};

/** Resolve the root field behind an operation-kind ref, if it still exists. */
export const graphqlRootField = (
  document: GraphqlDocument,
  ref: ApiOperationRef
): GraphqlField | undefined => {
  if (!isGraphqlOperationKind(ref.method)) {
    return undefined;
  }
  const rootName = document.roots[ref.method];
  const root = rootName === undefined ? undefined : document.types[rootName];
  return root?.fields?.find((field) => field.name === ref.operationId);
};

/** Resolve the named type behind a type-page ref, if it still exists. */
export const graphqlTypeDef = (
  document: GraphqlDocument,
  ref: ApiOperationRef
): GraphqlTypeDef | undefined => {
  const type = document.types[ref.operationId ?? ""];
  return type && type.kind === ref.method ? type : undefined;
};
