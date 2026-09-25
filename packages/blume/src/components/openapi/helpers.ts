import { sample } from "openapi-sampler";

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

/** Resolve one level of `$ref` against the document's component schemas. */
export const resolveSchema = (
  schemas: Record<string, SchemaLike>,
  schema?: SchemaLike
): SchemaLike => {
  if (!schema) {
    return {};
  }
  if (isString(schema.$ref)) {
    const name = REF_PATTERN.exec(schema.$ref)?.groups?.name;
    if (name && schemas[name]) {
      return schemas[name];
    }
  }
  return schema;
};

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
    return "object";
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

/** Human-readable validation constraints for a schema, in display order. */
export const constraints = (schema: SchemaLike): string[] => {
  const out: string[] = [];
  const numeric: [keyof SchemaLike, string][] = [
    ["minimum", "min"],
    ["maximum", "max"],
    ["minLength", "min length"],
    ["maxLength", "max length"],
    ["minItems", "min items"],
    ["maxItems", "max items"],
  ];
  for (const [key, label] of numeric) {
    const value = schema[key];
    if (isNumber(value)) {
      out.push(`${label} ${value}`);
    }
  }
  if (isString(schema.pattern)) {
    out.push(`matches ${schema.pattern}`);
  }
  if (schema.default !== undefined) {
    out.push(`default: ${JSON.stringify(schema.default)}`);
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

/**
 * Build a representative example value for a schema via openapi-sampler
 * (Redoc's generator): declared `example`/`const`/`default`/`enum` values
 * win, formats produce realistic placeholders (`email`, `uuid`, `date-time`),
 * and circular `$ref` chains — which keeping refs intact allows — terminate
 * safely. A request sample skips `readOnly` fields (a server-generated field
 * has no place in one); a response sample skips `writeOnly` fields (a
 * password the client sends never comes back) and keeps the `readOnly` ones.
 */
export const exampleValue = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  direction: "request" | "response" = "request"
): SpecValue => {
  if (!schema) {
    return null;
  }
  const response = direction === "response";
  try {
    // SAFETY: SchemaLike structurally covers the JSONSchema7 fields the
    // sampler reads, and the sampler only ever assembles JSON values.
    return sample(
      schema as Parameters<typeof sample>[0],
      { quiet: true, skipReadOnly: !response, skipWriteOnly: response },
      { components: { schemas } }
    ) as SpecValue;
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

const isRecord = (value: SpecValue): value is Record<string, SpecValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/**
 * A response media type's example for the Response panel: the declared one,
 * else a sample built for the response direction (`readOnly` kept,
 * `writeOnly` skipped).
 */
export const responseExample = (
  media: ExampleCarrier & { schema?: SchemaLike },
  schemas: Record<string, SchemaLike>,
  components?: ComponentsLike
): SpecValue =>
  declaredExample(media, components) ??
  exampleValue(media.schema, schemas, "response");

/** Pretty-print a JSON value for an example/code block. */
export const toJson = <T>(value: T): string => JSON.stringify(value, null, 2);
