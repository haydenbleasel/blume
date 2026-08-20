import type {
  GraphQLArgument,
  GraphQLEnumType,
  GraphQLField,
  GraphQLInputField,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLUnionType,
} from "graphql";
import {
  buildClientSchema,
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isSpecifiedScalarType,
  isUnionType,
  print,
} from "graphql";

import type {
  GraphqlDocument,
  GraphqlEnumValue,
  GraphqlField as ModelField,
  GraphqlInputValue,
  GraphqlTypeDef,
  GraphqlTypeRef,
} from "./graphql.ts";

/**
 * Lower schema text — SDL or an introspection result — into the serializable
 * {@link GraphqlDocument} the reference renders from. This is the only module
 * that imports `graphql`-js, and it runs Node-side at parse time only (see
 * `parseGraphqlSpec` in `parse.ts`), so the parser never reaches the generated
 * runtime or the browser. Throws plain Errors for unreadable schemas; the
 * caller wraps them as content problems.
 */

/** A type expression flattened to its display form and core named type. */
const typeRef = (
  type: GraphQLField<unknown, unknown>["type"] | GraphQLInputField["type"]
): GraphqlTypeRef => ({
  display: String(type),
  name: getNamedType(type).name,
});

/**
 * An argument's or input field's default, printed as a GraphQL literal. Both
 * SDL- and introspection-built schemas carry the default as a const AST node
 * (`default.literal`); a schema constructed programmatically with a coerced
 * `value` instead never reaches this module (it only builds from text).
 */
const defaultLiteral = (
  input: GraphQLArgument | GraphQLInputField
): string | undefined => {
  const literal = input.default?.literal;
  return literal ? print(literal) : undefined;
};

const inputValue = (
  input: GraphQLArgument | GraphQLInputField
): GraphqlInputValue => {
  const value: GraphqlInputValue = {
    description: input.description ?? "",
    name: input.name,
    type: typeRef(input.type),
  };
  const printed = defaultLiteral(input);
  if (printed !== undefined) {
    value.default = printed;
  }
  // `deprecationReason` is null on non-deprecated members in some builds;
  // absent means "not deprecated" downstream, so both collapse to absent.
  if (
    input.deprecationReason !== null &&
    input.deprecationReason !== undefined
  ) {
    value.deprecationReason = input.deprecationReason;
  }
  return value;
};

const outputField = (field: GraphQLField<unknown, unknown>): ModelField => {
  const value: ModelField = {
    args: field.args.map(inputValue),
    description: field.description ?? "",
    name: field.name,
    type: typeRef(field.type),
  };
  if (
    field.deprecationReason !== null &&
    field.deprecationReason !== undefined
  ) {
    value.deprecationReason = field.deprecationReason;
  }
  return value;
};

const enumValues = (type: GraphQLEnumType): GraphqlEnumValue[] =>
  type.getValues().map((value) => {
    const member: GraphqlEnumValue = {
      description: value.description ?? "",
      name: value.name,
    };
    if (
      value.deprecationReason !== null &&
      value.deprecationReason !== undefined
    ) {
      member.deprecationReason = value.deprecationReason;
    }
    return member;
  });

const objectDef = (
  type: GraphQLObjectType | GraphQLInterfaceType,
  kind: "object" | "interface"
): GraphqlTypeDef => {
  const interfaces = type.getInterfaces().map((iface) => iface.name);
  const def: GraphqlTypeDef = {
    description: type.description ?? "",
    fields: Object.values(type.getFields()).map(outputField),
    kind,
    name: type.name,
  };
  if (interfaces.length > 0) {
    def.interfaces = interfaces;
  }
  return def;
};

const inputDef = (type: GraphQLInputObjectType): GraphqlTypeDef => ({
  description: type.description ?? "",
  inputFields: Object.values(type.getFields()).map(inputValue),
  kind: "input",
  name: type.name,
});

const unionDef = (type: GraphQLUnionType): GraphqlTypeDef => ({
  description: type.description ?? "",
  kind: "union",
  name: type.name,
  possibleTypes: type.getTypes().map((member) => member.name),
});

const scalarDef = (type: GraphQLScalarType): GraphqlTypeDef => {
  const def: GraphqlTypeDef = {
    description: type.description ?? "",
    kind: "scalar",
    name: type.name,
  };
  if (type.specifiedByURL !== null && type.specifiedByURL !== undefined) {
    def.specifiedByUrl = type.specifiedByURL;
  }
  if (isSpecifiedScalarType(type)) {
    def.builtIn = true;
  }
  return def;
};

const typeDef = (
  type: GraphQLNamedType,
  schema: GraphQLSchema
): GraphqlTypeDef => {
  if (isObjectType(type)) {
    return objectDef(type, "object");
  }
  if (isInterfaceType(type)) {
    const def = objectDef(type, "interface");
    // Implementations are indexed on the schema, not the type — captured here
    // so the type page can list "implemented by" without a schema in hand.
    const implementers = schema
      .getImplementations(type)
      .objects.map((object) => object.name);
    if (implementers.length > 0) {
      def.possibleTypes = implementers;
    }
    return def;
  }
  if (isInputObjectType(type)) {
    return inputDef(type);
  }
  if (isEnumType(type)) {
    return {
      description: type.description ?? "",
      enumValues: enumValues(type),
      kind: "enum",
      name: type.name,
    };
  }
  if (isUnionType(type)) {
    return unionDef(type);
  }
  // SAFETY: the named-type union is exhaustive — after the object, interface,
  // input, enum, and union guards, only scalars remain.
  return scalarDef(type as GraphQLScalarType);
};

/** Lower a built schema to the serializable document. */
const documentOf = (schema: GraphQLSchema): GraphqlDocument => {
  const types: Record<string, GraphqlTypeDef> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    // Introspection meta-types (`__Schema`, `__Type`, …) are machinery, not API.
    if (name.startsWith("__")) {
      continue;
    }
    types[name] = typeDef(type, schema);
  }
  const roots: GraphqlDocument["roots"] = {};
  const query = schema.getQueryType();
  const mutation = schema.getMutationType();
  const subscription = schema.getSubscriptionType();
  if (query) {
    roots.query = query.name;
  }
  if (mutation) {
    roots.mutation = mutation.name;
  }
  if (subscription) {
    roots.subscription = subscription.name;
  }
  return {
    info: { description: schema.description ?? "" },
    roots,
    types,
  };
};

/**
 * A parsed JSON value carrying an introspection result's `__schema` key —
 * possibly under the standard `{ data: … }` GraphQL response envelope. The
 * generic-guard shape mirrors the document checks in `parse.ts`; the real
 * validation is `buildClientSchema`'s, which throws a descriptive error on
 * anything malformed inside `__schema`.
 */
const hasSchemaKey = <Value>(
  value: Value
): value is Value & { __schema: object } =>
  typeof value === "object" && value !== null && "__schema" in value;

/** A parsed JSON value shaped like a GraphQL response envelope. */
const hasDataEnvelope = <Value>(
  value: Value
): value is Value & { data: unknown } =>
  typeof value === "object" && value !== null && "data" in value;

/** The introspection result inside a parsed JSON value, if it carries one. */
const introspectionOf = <Value>(parsed: Value): object | undefined => {
  if (hasSchemaKey(parsed)) {
    return parsed;
  }
  return hasDataEnvelope(parsed) && hasSchemaKey(parsed.data)
    ? parsed.data
    : undefined;
};

/**
 * Build the document from schema text: an introspection JSON result (the raw
 * `{ __schema }` shape or a `{ data: { __schema } }` response envelope) or
 * SDL. Anything else throws — JSON that isn't an introspection result names
 * that problem directly instead of earning SDL syntax errors for a `{`.
 */
export const buildGraphqlDocument = (text: string): GraphqlDocument => {
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJson = false;
  }
  if (isJson) {
    const introspection = introspectionOf(parsed);
    if (!introspection) {
      throw new Error(
        "the JSON document is not a GraphQL introspection result (no `__schema` key)."
      );
    }
    // SAFETY: the guard above only establishes the `__schema` key;
    // `buildClientSchema` validates the full introspection shape itself and
    // throws a descriptive error on anything malformed.
    return documentOf(
      buildClientSchema(
        introspection as Parameters<typeof buildClientSchema>[0]
      )
    );
  }
  return documentOf(buildSchema(text));
};
