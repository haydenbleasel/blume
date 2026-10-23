import { sample } from "openapi-sampler";

import type { ReferenceStrings } from "./strings.ts";

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

/**
 * Resolve one level of `$ref` against the document's component schemas. A
 * single-member `allOf` wrapper resolves like its member, with the wrapper's
 * own keywords on top: its `description` is about this field. So does a
 * `$ref` with keywords beside it, which OpenAPI 3.1 allows and .NET writes
 * for every enum-typed property: the `description` beside the `$ref` is the
 * property's, the referenced one the type's.
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
    return { ...resolveSchema(schemas, member), ...own };
  }
  if (isString(schema.$ref)) {
    const name = REF_PATTERN.exec(schema.$ref)?.groups?.name;
    const target = name ? schemas[name] : undefined;
    if (target) {
      const { $ref: _ref, ...own } = schema;
      return Object.keys(own).length > 0 ? { ...target, ...own } : target;
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
 * A short, human-readable type label for a schema row. `$ref`s label by name
 * (`Pet`, `Pet[]`) without resolving — which also means circular refs through
 * array items can't recurse forever. A `null` member stays out of a union's
 * label: rows mark it with {@link isNullable}, as they do `type: [T, "null"]`.
 * A single-member `allOf` wrapper labels as its member; a real composition is
 * an `object`.
 */
export const typeLabel = (schema: SchemaLike): string => {
  if (isString(schema.$ref)) {
    return refName(schema.$ref);
  }
  if (schema.oneOf || schema.anyOf) {
    const branches = schema.oneOf ?? schema.anyOf ?? [];
    const members = branches.filter((branch) => !isNullType(branch));
    if (members.length === 0 && branches.length > 0) {
      return "null";
    }
    const labels = members.map((branch) => typeLabel(branch));
    return [...new Set(labels)].join(" | ") || "any";
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
>;

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
 * `allOf`-composed model still lists every field. Returns the properties plus
 * the merged required set.
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
      properties.set(name, prop);
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

const isRecord = (value: SpecValue): value is Record<string, SpecValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/**
 * A schema as openapi-sampler should read it: each `$ref` with an example
 * value beside it (`example`, `examples`, `default`, `const`) wrapped as a
 * single-member `allOf`, so the value is used. The sampler follows a `$ref`
 * before it looks at anything beside it, which OpenAPI 3.1 allows and .NET
 * writes, so `{ $ref: Status, example: "active" }` sampled the referenced
 * enum's first member instead.
 */
const sampleable = (schema: SpecValue): SpecValue => {
  if (Array.isArray(schema)) {
    return schema.map(sampleable);
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const out: Record<string, SpecValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = DATA_KEYWORDS.has(key) ? value : sampleable(value);
  }
  const { $ref: ref, ...own } = out;
  if (!(isString(ref) && VALUE_KEYWORDS.some((key) => key in own))) {
    return out;
  }
  const members = Array.isArray(own.allOf) ? own.allOf : [];
  return { ...own, allOf: [{ $ref: ref }, ...members] };
};

/** {@link sampleable} component schemas, once per document. */
const sampleableSchemas = new WeakMap<
  Record<string, SchemaLike>,
  Record<string, SchemaLike>
>();

const sampleableComponents = (
  schemas: Record<string, SchemaLike>
): Record<string, SchemaLike> => {
  const cached = sampleableSchemas.get(schemas);
  if (cached) {
    return cached;
  }
  // SAFETY: rewriting a `$ref` node into an `allOf` wrapper keeps every
  // entry a schema.
  const rewritten = sampleable(schemas) as Record<string, SchemaLike>;
  sampleableSchemas.set(schemas, rewritten);
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
 */
export const exampleValue = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection = "request"
): SpecValue => {
  if (!schema) {
    return null;
  }
  const response = direction === "response";
  try {
    // SAFETY: SchemaLike structurally covers the JSONSchema7 fields the
    // sampler reads, and the sampler only ever assembles JSON values.
    const value = sample(
      sampleable(schema) as Parameters<typeof sample>[0],
      { quiet: true, skipReadOnly: !response, skipWriteOnly: response },
      { components: { schemas: sampleableComponents(schemas) } }
    ) as SpecValue;
    return forDirection(value, schema, schemas, direction);
  } catch {
    // An unresolvable $ref or malformed schema is a spec problem the schema
    // tables already surface; a sample is best-effort.
    return null;
  }
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
