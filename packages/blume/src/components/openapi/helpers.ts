import { sample } from "openapi-sampler";

import type { ValidationSchema } from "./request.ts";
import type { ReferenceStrings } from "./strings.ts";
import { matchesSchema } from "./validate-json.ts";
import type { JsonValue } from "./validate-json.ts";

/**
 * Runtime helpers for the OpenAPI components. These operate on the parsed spec
 * behind the `blume:openapi` alias — resolving `$ref`s (kept intact at parse
 * time to avoid circular graphs), labelling types, and generating request
 * examples and code samples. Browser-safe (no server-only imports); example
 * values come from openapi-sampler, which is likewise browser-safe.
 */

/** Any value a parsed OpenAPI document can hold: JSON, nested schemas included. */
export type SpecValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SpecValue[]
  | { [key: string]: SpecValue };

const isString = (value: SpecValue): value is string =>
  typeof value === "string";

const isNumber = (value: SpecValue): value is number =>
  typeof value === "number";

const isRecord = (value: SpecValue): value is Record<string, SpecValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value as JSON writes it, so `""` shows and `null` differs from `"null"`. */
export const jsonLiteral = (value: SpecValue): string =>
  JSON.stringify(value) ?? "undefined";

/** A permissive view of an OpenAPI 3.1 schema — only the fields we render. */
export interface SchemaLike {
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  items?: SchemaLike;
  enum?: SpecValue[];
  const?: SpecValue;
  default?: SpecValue;
  example?: SpecValue;
  examples?: SpecValue[];
  allOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  anyOf?: SchemaLike[];
  not?: SchemaLike;
  additionalProperties?: boolean | SchemaLike;
  nullable?: boolean;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  [key: string]: SpecValue;
}

/** A permissive view of an operation parameter — only the fields we render. */
export interface ParameterLike {
  $ref?: string;
  name?: string;
  in?: string;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: SchemaLike;
  example?: SpecValue;
  [key: string]: SpecValue;
}

/** The `components` object of a parsed spec: section name → named-node table. */
export type ComponentsLike = Record<
  string,
  Record<string, SpecValue> | undefined
>;

const REF_PATTERN = /#\/components\/schemas\/(?<name>[^/]+)$/u;

const COMPONENT_REF = /#\/components\/(?<section>[^/]+)\/(?<name>[^/]+)$/u;

/**
 * Resolve one level of `$ref` against a named `components` section
 * (`parameters`, `requestBodies`, `responses`). Mirrors {@link resolveSchema}:
 * an unknown ref — or one pointing into a different section — is returned
 * as-is.
 */
export const resolveComponentRef = <T extends { $ref?: string }>(
  node: T,
  components: ComponentsLike | undefined,
  section: string
): T => {
  if (!isString(node.$ref)) {
    return node;
  }
  const groups = COMPONENT_REF.exec(node.$ref)?.groups;
  if (groups?.section !== section) {
    return node;
  }
  // SAFETY: a components section table stores nodes of that section's type,
  // and callers always pair `section` with the matching `T`.
  const table = components?.[section] as Record<string, T> | undefined;
  return table?.[groups.name ?? ""] ?? node;
};

/**
 * Path-level and operation-level parameters merged into one render list.
 * `$ref`s resolve against `components.parameters` first; then an operation
 * parameter overrides a path-level one with the same `name` + `in` (the
 * OpenAPI override rule), so a re-declared parameter appears once.
 */
export const mergeParameters = (
  pathParameters: ParameterLike[] | undefined,
  operationParameters: ParameterLike[] | undefined,
  components?: ComponentsLike
): ParameterLike[] => {
  const merged = new Map<string, ParameterLike>();
  let position = 0;
  for (const raw of [
    ...(pathParameters ?? []),
    ...(operationParameters ?? []),
  ]) {
    const param = resolveComponentRef(raw, components, "parameters");
    // A nameless parameter is invalid per spec, but key it uniquely so it is
    // still rendered rather than collapsing with other invalid entries.
    const key = param.name ? `${param.in ?? ""}:${param.name}` : `#${position}`;
    merged.set(key, param);
    position += 1;
  }
  return [...merged.values()];
};

/** The display name of a `$ref`, e.g. `#/components/schemas/Pet` -> `Pet`. */
export const refName = (ref: string): string =>
  REF_PATTERN.exec(ref)?.groups?.name ?? ref.split("/").at(-1) ?? ref;

/**
 * The one member of an `allOf` that only wraps it: `allOf: [{ $ref }]` beside
 * a `description`, `readOnly`, or `default`, which is how drf-spectacular and
 * other generators attach keywords a 3.0 `$ref` can't carry. `undefined` for
 * a real composition: several members, or properties or branches of its own.
 */
export const soleAllOfMember = (schema: SchemaLike): SchemaLike | undefined =>
  schema.allOf?.length === 1 &&
  !(schema.properties || schema.oneOf || schema.anyOf)
    ? schema.allOf[0]
    : undefined;

/** Bounds where two schemas on one value keep the larger, then the smaller. */
const LOWER_BOUNDS = [
  "exclusiveMinimum",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
] as const;

const UPPER_BOUNDS = [
  "exclusiveMaximum",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
] as const;

/**
 * The `anyOf`, `oneOf`, and `const` of `base` that `over` replaces with a
 * different one, each as an `allOf` member so both still bind. Tables show
 * `over`'s, the property's own; validation checks both.
 */
const replacedAssertions = (base: SchemaLike, over: SchemaLike): SchemaLike[] =>
  (["anyOf", "const", "oneOf"] as const).flatMap((key) =>
    base[key] !== undefined &&
    over[key] !== undefined &&
    jsonLiteral(base[key]) !== jsonLiteral(over[key])
      ? [{ [key]: base[key] }]
      : []
  );

/** Two different `not`s as one that rules out what either does. */
const bothNots = (
  first: SchemaLike | undefined,
  second: SchemaLike | undefined
): SchemaLike | undefined =>
  first && second && jsonLiteral(first) !== jsonLiteral(second)
    ? { anyOf: [first, second] }
    : undefined;

/**
 * Two schemas that both apply to one value, as one schema: the `required`
 * names and `properties` of both (a property both declare merged the same
 * way), the tighter of two bounds, the values two `enum`s share, and the
 * `allOf` members of both. A different `anyOf`, `oneOf`, or `const` keeps
 * both (see {@link replacedAssertions}), and two `not`s rule out what either
 * does: a `$ref` that rules out `"reserved"` and a sibling that rules out
 * `"forbidden"` rule out both. Any other keyword both declare takes `over`'s
 * value, so the `description` beside a `$ref` is the property's. Two
 * different `$ref`s can't share one node, so they stay an `allOf`.
 */
export const mergeSchemas = (
  base: SchemaLike,
  over: SchemaLike
): SchemaLike => {
  if (isString(base.$ref) && isString(over.$ref) && base.$ref !== over.$ref) {
    return { allOf: [base, over] };
  }
  const merged: SchemaLike = { ...base, ...over };
  if (base.required && over.required) {
    merged.required = [...new Set([...base.required, ...over.required])];
  }
  if (base.properties && over.properties) {
    const properties = { ...base.properties };
    for (const [name, property] of Object.entries(over.properties)) {
      const earlier = properties[name];
      properties[name] = earlier ? mergeSchemas(earlier, property) : property;
    }
    merged.properties = properties;
  }
  for (const [keys, pick] of [
    [LOWER_BOUNDS, Math.max],
    [UPPER_BOUNDS, Math.min],
  ] as const) {
    for (const key of keys) {
      const [first, second] = [base[key], over[key]];
      if (isNumber(first) && isNumber(second)) {
        merged[key] = pick(first, second);
      }
    }
  }
  if (base.enum && over.enum) {
    const allowed = new Set(over.enum.map(jsonLiteral));
    merged.enum = base.enum.filter((value) => allowed.has(jsonLiteral(value)));
  }
  const allOf = [
    ...(base.allOf ?? []),
    ...(over.allOf ?? []),
    ...replacedAssertions(base, over),
  ];
  if (allOf.length > 0) {
    merged.allOf = allOf;
  }
  const not = bothNots(base.not, over.not);
  if (not) {
    merged.not = not;
  }
  return merged;
};

/**
 * Resolve one level of `$ref` against the document's component schemas. A
 * single-member `allOf` wrapper resolves like its member, with the wrapper's
 * own keywords on top: its `description` is about this field. So does a
 * `$ref` with keywords beside it, which OpenAPI 3.1 allows and .NET writes
 * for every enum-typed property: the `description` beside the `$ref` is the
 * property's, the referenced one the type's. The keywords beside it add to
 * the referenced schema's rather than replace them (see {@link mergeSchemas}):
 * a `required` beside a `$ref` adds names to the ones the schema requires.
 */
export const resolveSchema = (
  schemas: Record<string, SchemaLike>,
  schema?: SchemaLike
): SchemaLike => {
  if (!schema) {
    return {};
  }
  const member = soleAllOfMember(schema);
  if (member) {
    const { allOf: _wrapped, ...own } = schema;
    return mergeSchemas(resolveSchema(schemas, member), own);
  }
  if (isString(schema.$ref)) {
    const name = REF_PATTERN.exec(schema.$ref)?.groups?.name;
    const target = name ? schemas[name] : undefined;
    if (target) {
      const { $ref: _ref, ...own } = schema;
      return Object.keys(own).length > 0 ? mergeSchemas(target, own) : target;
    }
  }
  return schema;
};

/**
 * A parameter's description: its own, else its schema's (resolved one `$ref`
 * level), which is where generators like Elysia and oRPC write it.
 */
export const parameterDescription = (
  param: { description?: string; schema?: SchemaLike },
  schemas: Record<string, SchemaLike>
): string | undefined =>
  param.description ?? resolveSchema(schemas, param.schema).description;

const declaredTypeList = (type: string | string[] | undefined): string[] => {
  if (!type) {
    return [];
  }
  return Array.isArray(type) ? type : [type];
};

const nonNullTypes = (type: string | string[] | undefined): string[] =>
  declaredTypeList(type).filter((t) => t !== "null");

/**
 * Whether a schema admits only `null`: `{ type: "null" }`, the branch Scalar's
 * upgrade pairs with a 3.0 `nullable: true` `$ref` (`anyOf: [$ref, { type:
 * "null" }]`).
 */
const isNullType = (schema: SchemaLike): boolean => {
  const types = declaredTypeList(schema.type);
  return types.length > 0 && types.every((type) => type === "null");
};

/**
 * The schema of a map's values: an object that names no properties of its own
 * but takes `additionalProperties` (`true` is any value).
 */
const mapValues = (
  schema: SchemaLike,
  types: string[]
): SchemaLike | undefined => {
  const values = schema.additionalProperties;
  if (schema.properties || !values || (types[0] ?? "object") !== "object") {
    return undefined;
  }
  return values === true ? {} : values;
};

/**
 * Whether a `oneOf`/`anyOf` variant says what type its value is. One that
 * doesn't, like `{ required: ["card"] }`, narrows the schema it sits in, so
 * it has that schema's type.
 */
export const declaresType = (schema: SchemaLike): boolean =>
  Boolean(
    schema.$ref ||
    schema.type ||
    schema.properties ||
    schema.items ||
    schema.additionalProperties ||
    schema.allOf ||
    schema.oneOf ||
    schema.anyOf
  );

/**
 * A short, human-readable type label for a schema row. `$ref`s label by name
 * (`Pet`, `Pet[]`) without resolving — which also means circular refs through
 * array items can't recurse forever. A `null` member stays out of a union's
 * label: rows mark it with {@link isNullable}, as they do `type: [T, "null"]`,
 * and a variant that declares no type has the schema's own. A single-member
 * `allOf` wrapper labels as its member; a real composition is an `object`.
 * An object whose values are all one schema is a `map<string, T>`.
 */
export const typeLabel = (schema: SchemaLike): string => {
  if (isString(schema.$ref)) {
    return refName(schema.$ref);
  }
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches) {
    const { anyOf: _anyOf, oneOf: _oneOf, ...own } = schema;
    const members = branches.filter((branch) => !isNullType(branch));
    if (members.length === 0 && branches.length > 0) {
      return "null";
    }
    const labels = members.map((branch) =>
      typeLabel(declaresType(branch) ? branch : own)
    );
    return [...new Set(labels)].join(" | ") || typeLabel(own);
  }
  if (schema.allOf) {
    const member = soleAllOfMember(schema);
    return member ? typeLabel(member) : "object";
  }
  const types = nonNullTypes(schema.type);
  const arrayLabel = (): string => `${typeLabel(schema.items ?? {})}[]`;
  if (types.length > 1) {
    // A 3.1 type array names every type the value may take, not just the first.
    return types
      .map((type) => (type === "array" ? arrayLabel() : type))
      .join(" | ");
  }
  if (types.includes("array")) {
    return arrayLabel();
  }
  if (types.length === 0 && isNullType(schema)) {
    return "null";
  }
  const values = mapValues(schema, types);
  if (values) {
    return `map<string, ${typeLabel(values)}>`;
  }
  const base = types[0] ?? (schema.properties ? "object" : "any");
  return schema.format ? `${base}<${schema.format}>` : base;
};

/**
 * Whether this schema is nullable: 3.0 `nullable`, a 3.1 `"null"` in `type`,
 * or a `{ type: "null" }` member of a `oneOf`/`anyOf` union.
 */
export const isNullable = (schema: SchemaLike): boolean =>
  schema.nullable === true ||
  (Array.isArray(schema.type) && schema.type.includes("null")) ||
  [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some(isNullType);

/** The labels {@link constraints} words its lines with. */
export type ConstraintStrings = Pick<
  ReferenceStrings,
  | "defaultValue"
  | "matches"
  | "max"
  | "maxItems"
  | "maxLength"
  | "min"
  | "minItems"
  | "minLength"
  | "not"
>;

/** The keywords a `not` can be worded from; any other one narrows it. */
const WORDED = new Set([
  "anyOf",
  "const",
  "deprecated",
  "description",
  "enum",
  "format",
  "title",
  "type",
]);

/**
 * The values a `not` rules out: its `const`, its `enum`, each of its `anyOf`
 * variants, else its type. `undefined` when it narrows them further, as
 * `not: { required: [a, b] }` does: "not object" would rule out more than
 * the schema does.
 */
const excluded = (schema: SchemaLike): string | undefined => {
  if (Object.keys(schema).some((key) => !WORDED.has(key))) {
    return undefined;
  }
  if (schema.const !== undefined) {
    return jsonLiteral(schema.const);
  }
  if (schema.anyOf) {
    const parts = schema.anyOf.map(excluded);
    return parts.every((part) => part !== undefined)
      ? parts.join(" | ")
      : undefined;
  }
  return schema.enum
    ? schema.enum.map(jsonLiteral).join(" | ")
    : typeLabel(schema);
};

/** The values a schema allows, when it lists them: its `enum`, or its `const`. */
export const allowedValues = (schema: SchemaLike): SpecValue[] | undefined => {
  if (schema.enum) {
    return schema.enum;
  }
  return schema.const === undefined ? undefined : [schema.const];
};

/** Human-readable validation constraints for a schema, in display order. */
export const constraints = (
  schema: SchemaLike,
  strings: ConstraintStrings
): string[] => {
  const out: string[] = [];
  const numeric: [keyof SchemaLike, string][] = [
    ["minimum", strings.min],
    ["maximum", strings.max],
    ["minLength", strings.minLength],
    ["maxLength", strings.maxLength],
    ["minItems", strings.minItems],
    ["maxItems", strings.maxItems],
  ];
  for (const [key, label] of numeric) {
    const value = schema[key];
    if (isNumber(value)) {
      out.push(label.replaceAll("{n}", () => String(value)));
    }
  }
  const { pattern } = schema;
  if (isString(pattern)) {
    out.push(strings.matches.replaceAll("{pattern}", () => pattern));
  }
  const ruledOut = schema.not && excluded(schema.not);
  if (ruledOut !== undefined) {
    out.push(strings.not.replaceAll("{value}", () => ruledOut));
  }
  if (schema.default !== undefined) {
    const value = JSON.stringify(schema.default);
    out.push(strings.defaultValue.replaceAll("{value}", () => value));
  }
  return out;
};

/** The merged property list and required set a schema exposes. */
export interface ObjectPropertySet {
  properties: [string, SchemaLike][];
  required: Set<string>;
}

/**
 * The object properties a schema exposes, merging `allOf` branches so an
 * `allOf`-composed model still lists every field. A property several members
 * declare keeps every member's constraints (see {@link mergeSchemas}).
 * Returns the properties plus the merged required set.
 */
export const objectProperties = (
  schema: SchemaLike,
  schemas: Record<string, SchemaLike>
): ObjectPropertySet => {
  const properties = new Map<string, SchemaLike>();
  const required = new Set<string>();
  // Cycles can only enter through `$ref`s (inline JSON can't self-nest), so
  // tracking visited refs is enough to stop circular allOf chains recursing.
  const seen = new Set<string>();

  const collect = (node: SchemaLike): void => {
    if (isString(node.$ref)) {
      if (seen.has(node.$ref)) {
        return;
      }
      seen.add(node.$ref);
    }
    const resolved = resolveSchema(schemas, node);
    for (const name of resolved.required ?? []) {
      required.add(name);
    }
    for (const [name, prop] of Object.entries(resolved.properties ?? {})) {
      const earlier = properties.get(name);
      properties.set(name, earlier ? mergeSchemas(earlier, prop) : prop);
    }
    for (const branch of resolved.allOf ?? []) {
      collect(branch);
    }
  };

  collect(schema);
  return { properties: [...properties.entries()], required };
};

/** Which way an example travels: to the API, or back from it. */
export type ExampleDirection = "request" | "response";

/** Keywords whose values are data, not schemas, so never rewritten. */
const DATA_KEYWORDS = new Set([
  "const",
  "default",
  "enum",
  "example",
  "examples",
]);

/** Keywords beside a `$ref` that give the value an example of its own. */
const VALUE_KEYWORDS = ["const", "default", "example", "examples"];

/** The keywords that hold an author's example of a value. */
const EXAMPLE_KEYWORDS = new Set(["example", "examples"]);

const requiredNames = (schema: SpecValue): string[] =>
  isRecord(schema) && Array.isArray(schema.required)
    ? schema.required.filter(isString)
    : [];

/**
 * A `oneOf` narrowed to its first variant, without the properties only the
 * other variants require. The sampler fills every declared property, so
 * beside `oneOf: [{ required: [card] }, { required: [iban] }]` it sent both,
 * a value that matches both variants and so neither `oneOf` allows.
 */
const firstVariant = (schema: Record<string, SpecValue>) => {
  const { oneOf, properties } = schema;
  if (!(Array.isArray(oneOf) && oneOf.length > 1 && isRecord(properties))) {
    return schema;
  }
  const [first, ...others] = oneOf;
  const kept = new Set([...requiredNames(schema), ...requiredNames(first)]);
  const exclusive = new Set(
    others.flatMap(requiredNames).filter((name) => !kept.has(name))
  );
  return {
    ...schema,
    oneOf: [first],
    properties: Object.fromEntries(
      Object.entries(properties).filter(([name]) => !exclusive.has(name))
    ),
  };
};

/**
 * How one sample is built: `narrow` narrows every `oneOf` to its first
 * variant (see {@link firstVariant}); without `declared`, the schemas'
 * `example` and `examples` are left out, so the value is built from types,
 * formats, `enum`s, `const`s, and `default`s alone.
 */
interface SampleMode {
  declared: boolean;
  narrow: boolean;
}

/**
 * The candidates {@link exampleValue} tries, in order: the sample as built,
 * then narrowed, then also without the schemas' own examples,
 * which an example that breaks its schema (an `enum` value it no longer
 * lists) would otherwise keep out of every sample.
 */
const SAMPLE_MODES: SampleMode[] = [
  { declared: true, narrow: false },
  { declared: true, narrow: true },
  { declared: false, narrow: true },
];

/** A name-to-value map with `change` applied to each value. */
const mapEntries = (
  map: Record<string, SpecValue>,
  change: (value: SpecValue) => SpecValue
): Record<string, SpecValue> =>
  Object.fromEntries(
    Object.entries(map).map(([name, value]) => [name, change(value)])
  );

/** Keywords whose value maps names to schemas, rather than being one. */
const SCHEMA_MAPS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/**
 * A schema as openapi-sampler should read it: each `$ref` with an example
 * value beside it (`example`, `examples`, `default`, `const`) wrapped as a
 * single-member `allOf`, so the value is used. The sampler follows a `$ref`
 * before it looks at anything beside it, which OpenAPI 3.1 allows and .NET
 * writes, so `{ $ref: Status, example: "active" }` sampled the referenced
 * enum's first member instead. The `mode` rewrites it further.
 */
const sampleable = (schema: SpecValue, mode: SampleMode): SpecValue => {
  if (Array.isArray(schema)) {
    return schema.map((member) => sampleable(member, mode));
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const rewritten: Record<string, SpecValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!DATA_KEYWORDS.has(key)) {
      rewritten[key] =
        SCHEMA_MAPS.has(key) && isRecord(value)
          ? mapEntries(value, (member) => sampleable(member, mode))
          : sampleable(value, mode);
    } else if (mode.declared || !EXAMPLE_KEYWORDS.has(key)) {
      rewritten[key] = value;
    }
  }
  const out = mode.narrow ? firstVariant(rewritten) : rewritten;
  const { $ref: ref, ...own } = out;
  if (!(isString(ref) && VALUE_KEYWORDS.some((key) => key in own))) {
    return out;
  }
  const members = Array.isArray(own.allOf) ? own.allOf : [];
  return { ...own, allOf: [{ $ref: ref }, ...members] };
};

/** {@link sampleable} component schemas, once per document and mode. */
const sampleableSchemas = new Map(
  SAMPLE_MODES.map((mode) => [
    mode,
    new WeakMap<Record<string, SchemaLike>, Record<string, SchemaLike>>(),
  ])
);

const sampleableComponents = (
  schemas: Record<string, SchemaLike>,
  mode: SampleMode
): Record<string, SchemaLike> => {
  const cache = sampleableSchemas.get(mode);
  const cached = cache?.get(schemas);
  if (cached) {
    return cached;
  }
  // SAFETY: each rewrite keeps every entry a schema.
  const rewritten = mapEntries(schemas, (schema) =>
    sampleable(schema, mode)
  ) as Record<string, SchemaLike>;
  cache?.set(schemas, rewritten);
  return rewritten;
};

/**
 * An example value with the properties that don't travel `direction` left
 * out, at every depth its schema describes: `readOnly` ones from a request,
 * which the server sets, and `writeOnly` ones from a response, which it
 * never returns. openapi-sampler skips those only in the values it builds; a
 * declared example (a model's `example`, which TypeSpec writes, or a media
 * type's) keeps them, so a request sample would send the model's `id`. A
 * property the schema doesn't describe stays as written.
 */
export const forDirection = (
  value: SpecValue,
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection
): SpecValue => {
  if (!schema) {
    return value;
  }
  if (Array.isArray(value)) {
    const { items } = resolveSchema(schemas, schema);
    return items
      ? value.map((item) => forDirection(item, items, schemas, direction))
      : value;
  }
  if (!isRecord(value)) {
    return value;
  }
  const properties = new Map(objectProperties(schema, schemas).properties);
  const omitted = direction === "request" ? "readOnly" : "writeOnly";
  const out: Record<string, SpecValue> = {};
  for (const [name, member] of Object.entries(value)) {
    const property = properties.get(name);
    if (
      property?.[omitted] === true ||
      resolveSchema(schemas, property)[omitted] === true
    ) {
      continue;
    }
    out[name] = forDirection(member, property, schemas, direction);
  }
  return out;
};

/** Recursion limit for pruned validation schemas — deep enough for real specs. */
const MAX_SCHEMA_DEPTH = 6;

/** The bounds the validator checks, copied as written. */
const BOUNDS = [...LOWER_BOUNDS, ...UPPER_BOUNDS].filter(
  (key) => key !== "minProperties" && key !== "maxProperties"
);

/** The checks on a value itself: its type, `null`, `enum`, `const`, and bounds. */
const valueRules = (resolved: SchemaLike): ValidationSchema => {
  const out: ValidationSchema = {};
  for (const key of BOUNDS) {
    const bound = resolved[key];
    if (isNumber(bound)) {
      out[key] = bound;
    }
  }
  // Only a single declared type is checked: a 3.1 type array like
  // `["string", "integer"]` accepts either, which one `type` can't say.
  const types = nonNullTypes(resolved.type);
  if (types.length === 1) {
    [out.type] = types;
  } else if (isNullType(resolved)) {
    out.type = "null";
  }
  if (isNullable(resolved)) {
    out.nullable = true;
  }
  if (resolved.enum) {
    out.enum = resolved.enum;
  }
  if (resolved.const !== undefined) {
    out.const = resolved.const;
  }
  return out;
};

/**
 * The names a value travelling `direction` must carry. A `readOnly`
 * property's `required` binds responses only: the server generates it, so a
 * request body — which the prefilled example already leaves it out of —
 * must not be told it is missing. A `writeOnly` one binds requests only.
 */
const requiredFor = (
  resolved: SchemaLike,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection
): string[] => {
  const omitted = direction === "request" ? "readOnly" : "writeOnly";
  return (resolved.required ?? []).filter((name) => {
    const property = resolved.properties?.[name];
    return !(
      property?.[omitted] === true ||
      resolveSchema(schemas, property)[omitted] === true
    );
  });
};

/**
 * Assertions the validator doesn't check. A pruned schema that drops one
 * accepts values its source rejects, which is harmless on its own but not
 * inside a `not` or a `oneOf` (see {@link variantRules}).
 */
const UNCHECKED = [
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "maxProperties",
  "minProperties",
  "multipleOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
] as const;

/**
 * Pruned schemas that check less than their source: they drop an
 * {@link UNCHECKED} assertion or `additionalProperties: false`, or a part of
 * them was cut (a cycle, the depth limit) or is partial itself.
 */
const partial = new WeakSet<ValidationSchema>();

const isDefined = (
  pruned: ValidationSchema | undefined
): pruned is ValidationSchema => pruned !== undefined;

/** Whether a pruned schema checks everything its source does. */
const isComplete = (
  pruned: ValidationSchema | undefined
): pruned is ValidationSchema => isDefined(pruned) && !partial.has(pruned);

/**
 * The `allOf`, `oneOf`, `anyOf`, and `not` checks, each member pruned, and
 * whether they check less than the source. A cut or partial member accepts
 * more than it should. That only loosens an `allOf` or an `anyOf` (a cut
 * `allOf` member is left out, and an `anyOf` with a cut one is), but it would
 * make a `not` reject valid values and a `oneOf` count too many matches. So
 * such a `not` is left out, and such a `oneOf` checks only that at least one
 * variant matches.
 */
const variantRules = (
  resolved: SchemaLike,
  prune: (member: SchemaLike) => ValidationSchema | undefined
): [ValidationSchema, boolean] => {
  const out: ValidationSchema = {};
  let loose = false;
  const pruneAll = (members: SchemaLike[] = []) => {
    const pruned = members.map(prune);
    loose ||= !pruned.every(isComplete);
    return pruned;
  };
  const allOf = pruneAll(resolved.allOf).filter(isDefined);
  const anyOf = pruneAll(resolved.anyOf);
  if (anyOf.length > 0 && anyOf.every(isDefined)) {
    out.anyOf = anyOf;
  }
  const oneOf = pruneAll(resolved.oneOf);
  if (oneOf.length > 0 && oneOf.every(isComplete)) {
    out.oneOf = oneOf;
  } else if (oneOf.length > 0 && oneOf.every(isDefined)) {
    allOf.push({ anyOf: oneOf });
  }
  if (allOf.length > 0) {
    out.allOf = allOf;
  }
  const [not] = pruneAll(resolved.not ? [resolved.not] : []);
  if (isComplete(not)) {
    out.not = not;
  }
  return [out, loose];
};

/**
 * The checks on an object's properties and a map's or array's members, and
 * whether they check less than the source.
 */
const memberRules = (
  resolved: SchemaLike,
  prune: (member: SchemaLike) => ValidationSchema | undefined
): [ValidationSchema, boolean] => {
  const out: ValidationSchema = {};
  let loose = false;
  const pruneOne = (member: SchemaLike) => {
    const pruned = prune(member);
    loose ||= !isComplete(pruned);
    return pruned;
  };
  const properties: Record<string, ValidationSchema> = {};
  for (const [name, property] of Object.entries(resolved.properties ?? {})) {
    const pruned = pruneOne(property);
    if (pruned) {
      properties[name] = pruned;
    }
  }
  if (Object.keys(properties).length > 0) {
    out.properties = properties;
  }
  const values = resolved.additionalProperties;
  const additional = isRecord(values) ? pruneOne(values) : undefined;
  if (additional) {
    out.additionalProperties = additional;
  }
  if (resolved.items) {
    out.items = pruneOne(resolved.items);
  }
  return [out, loose];
};

/**
 * Prune a spec schema into the subset `validate-json.ts` understands: `$ref`s
 * resolved inline, cycles cut (the visited set is copied per branch so a ref
 * reused by siblings still prunes fully), depth capped. Structure beyond the
 * cut simply goes unvalidated, so it can never block a send.
 */
const pruneSchema = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  depth: number,
  seen: ReadonlySet<string>,
  direction: ExampleDirection
): ValidationSchema | undefined => {
  if (!schema || depth >= MAX_SCHEMA_DEPTH) {
    return undefined;
  }
  let visited = seen;
  if (isString(schema.$ref)) {
    if (seen.has(schema.$ref)) {
      return undefined;
    }
    visited = new Set(seen).add(schema.$ref);
  }
  const prune = (member: SchemaLike | undefined) =>
    pruneSchema(member, schemas, depth + 1, visited, direction);
  const resolved = resolveSchema(schemas, schema);
  const [variants, looseVariants] = variantRules(resolved, prune);
  const [members, looseMembers] = memberRules(resolved, prune);
  const out: ValidationSchema = {
    ...valueRules(resolved),
    ...variants,
    ...members,
  };
  const required = requiredFor(resolved, schemas, direction);
  if (required.length > 0) {
    out.required = required;
  }
  if (
    looseVariants ||
    looseMembers ||
    resolved.additionalProperties === false ||
    UNCHECKED.some((key) => resolved[key] !== undefined)
  ) {
    partial.add(out);
  }
  return out;
};

/**
 * The validator-ready view of a spec schema for a value travelling
 * `direction`; undefined when there is none.
 */
export const validationSchema = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection = "request"
): ValidationSchema | undefined =>
  pruneSchema(schema, schemas, 0, new Set(), direction);

/**
 * Build a representative example value for a schema via openapi-sampler
 * (Redoc's generator): declared `example`/`const`/`default`/`enum` values
 * win, a value beside a `$ref` included, formats produce realistic
 * placeholders (`email`, `uuid`, `date-time`), and circular `$ref` chains —
 * which keeping refs intact allows — terminate safely. A request sample
 * leaves out `readOnly` fields (a server-generated field has no place in
 * one); a response sample leaves out `writeOnly` fields (a password the
 * client sends never comes back) and keeps the `readOnly` ones. That holds
 * inside a declared value the sampler copies too (see {@link forDirection}).
 *
 * The sampler knows no `oneOf` or `not` rules, so every sample is checked
 * against the whole schema, and one that fails it is never shown: the first
 * of the {@link SAMPLE_MODES} candidates that passes, else `undefined` — no
 * example, which a schema that only allows `null` (an example of `null`)
 * never returns.
 */
export const exampleValue = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection = "request"
): SpecValue => {
  if (!schema) {
    return undefined;
  }
  const response = direction === "response";
  const rules = validationSchema(schema, schemas, direction);
  for (const mode of SAMPLE_MODES) {
    try {
      // SAFETY: SchemaLike structurally covers the JSONSchema7 fields the
      // sampler reads, and the sampler only ever assembles JSON values.
      const sampled = sample(
        sampleable(schema, mode) as Parameters<typeof sample>[0],
        { quiet: true, skipReadOnly: !response, skipWriteOnly: response },
        { components: { schemas: sampleableComponents(schemas, mode) } }
      ) as SpecValue;
      const value = forDirection(sampled, schema, schemas, direction);
      // SAFETY: a sampled value is assembled JSON, never `undefined` inside.
      if (value !== undefined && matchesSchema(value as JsonValue, rules)) {
        return value;
      }
    } catch {
      // An unresolvable $ref or malformed schema is a spec problem the
      // schema tables already surface; a sample is best-effort.
    }
  }
  return undefined;
};

/** Where an author can declare an example: a parameter or a media type. */
export interface ExampleCarrier {
  example?: SpecValue;
  examples?: SpecValue;
}

/**
 * The example a parameter or media type declares: its `example`, else the
 * first `value` in its `examples` map — inline, or behind a `$ref` to
 * `#/components/examples`, resolved against `components`. Scalar's upgrade
 * moves every OpenAPI 3.0 and Swagger 2.0 `example` into
 * `examples.default.value`, and 3.1 authors write that map directly, so
 * reading `example` alone would drop them all. `undefined` when nothing is
 * declared.
 */
export const declaredExample = (
  carrier: ExampleCarrier,
  components?: ComponentsLike
): SpecValue => {
  if (carrier.example !== undefined) {
    return carrier.example;
  }
  const { examples } = carrier;
  if (!isRecord(examples)) {
    return undefined;
  }
  for (const entry of Object.values(examples)) {
    const example = isRecord(entry)
      ? resolveComponentRef(entry, components, "examples")
      : undefined;
    if (example?.value !== undefined) {
      return example.value;
    }
  }
  return undefined;
};

/** A media type: the schema of a body and the examples it declares. */
export type MediaLike = ExampleCarrier & { schema?: SchemaLike };

/**
 * A media type's example for a body travelling `direction`: the declared
 * one, else a sample built from its schema, with the properties that don't
 * travel that way left out (see {@link forDirection}).
 */
export const mediaExample = (
  media: MediaLike,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection,
  components?: ComponentsLike
): SpecValue => {
  const declared = declaredExample(media, components);
  return declared === undefined
    ? exampleValue(media.schema, schemas, direction)
    : forDirection(declared, media.schema, schemas, direction);
};

/**
 * A response media type's example for the Response panel: the declared one,
 * else a sample built for the response direction (`readOnly` kept,
 * `writeOnly` left out).
 */
export const responseExample = (
  media: MediaLike,
  schemas: Record<string, SchemaLike>,
  components?: ComponentsLike
): SpecValue => mediaExample(media, schemas, "response", components);

/** One of a media type's named examples, as a tab or the Markdown copy shows it. */
export interface NamedExample {
  /** The example's key in the `examples` map. */
  key: string;
  /** Its `summary`, else its key. */
  label: string;
  value: SpecValue;
}

/**
 * Every example a media type's `examples` map names, in order, `$ref`s to
 * `#/components/examples` resolved, each labeled by its `summary` or else
 * its key, with the properties that don't travel `direction` left out. Empty
 * unless the map names two or more: Scalar's upgrade files a 3.0 `example`
 * as the one entry `default`, which is no name to show, and a lone example
 * is the one {@link mediaExample} already gives.
 */
export const namedExamples = (
  media: MediaLike,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection,
  components?: ComponentsLike
): NamedExample[] => {
  if (media.example !== undefined || !isRecord(media.examples)) {
    return [];
  }
  const named: NamedExample[] = [];
  for (const [key, entry] of Object.entries(media.examples)) {
    const example = isRecord(entry)
      ? resolveComponentRef(entry, components, "examples")
      : undefined;
    if (example?.value === undefined) {
      continue;
    }
    named.push({
      key,
      label:
        isString(example.summary) && example.summary ? example.summary : key,
      value: forDirection(example.value, media.schema, schemas, direction),
    });
  }
  return named.length > 1 ? named : [];
};

/** Pretty-print a JSON value for an example/code block. */
export const toJson = <T>(value: T): string => JSON.stringify(value, null, 2);
