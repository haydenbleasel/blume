/**
 * Runtime helpers for the OpenAPI components. These operate on the parsed spec
 * behind the `blume:openapi` alias — resolving `$ref`s (kept intact at parse
 * time to avoid circular graphs), labelling types, and generating request
 * examples and code samples. Pure and dependency-free so they run in the browser
 * build with no server-only imports.
 */

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
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
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
  [key: string]: unknown;
}

const REF_PATTERN = /#\/components\/schemas\/(?<name>[^/]+)$/u;

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
  if (typeof schema.$ref === "string") {
    const name = REF_PATTERN.exec(schema.$ref)?.groups?.name;
    if (name && schemas[name]) {
      return schemas[name];
    }
  }
  return schema;
};

const nonNullTypes = (type: string | string[] | undefined): string[] => {
  if (!type) {
    return [];
  }
  return (Array.isArray(type) ? type : [type]).filter((t) => t !== "null");
};

/**
 * A short, human-readable type label for a schema row. `$ref`s label by name
 * (`Pet`, `Pet[]`) without resolving — which also means circular refs through
 * array items can't recurse forever.
 */
export const typeLabel = (schema: SchemaLike): string => {
  if (typeof schema.$ref === "string") {
    return refName(schema.$ref);
  }
  if (schema.oneOf || schema.anyOf) {
    const branches = schema.oneOf ?? schema.anyOf ?? [];
    const labels = branches.map((branch) => typeLabel(branch));
    return [...new Set(labels)].join(" | ") || "any";
  }
  if (schema.allOf) {
    return "object";
  }
  const types = nonNullTypes(schema.type);
  if (types.includes("array")) {
    return `${typeLabel(schema.items ?? {})}[]`;
  }
  const base = types[0] ?? (schema.properties ? "object" : "any");
  return schema.format ? `${base}<${schema.format}>` : base;
};

/** Whether this schema is nullable (3.0 `nullable` or a 3.1 `"null"` in `type`). */
export const isNullable = (schema: SchemaLike): boolean =>
  schema.nullable === true ||
  (Array.isArray(schema.type) && schema.type.includes("null"));

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
    if (typeof value === "number") {
      out.push(`${label} ${value}`);
    }
  }
  if (typeof schema.pattern === "string") {
    out.push(`matches ${schema.pattern}`);
  }
  if (schema.default !== undefined) {
    out.push(`default: ${JSON.stringify(schema.default)}`);
  }
  return out;
};

/**
 * The object properties a schema exposes, merging `allOf` branches so an
 * `allOf`-composed model still lists every field. Returns the properties plus
 * the merged required set.
 */
export const objectProperties = (
  schema: SchemaLike,
  schemas: Record<string, SchemaLike>
): { properties: [string, SchemaLike][]; required: Set<string> } => {
  const properties = new Map<string, SchemaLike>();
  const required = new Set<string>();
  // Cycles can only enter through `$ref`s (inline JSON can't self-nest), so
  // tracking visited refs is enough to stop circular allOf chains recursing.
  const seen = new Set<string>();

  const collect = (node: SchemaLike): void => {
    if (typeof node.$ref === "string") {
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

/** Sentinel: no explicit example is declared on a schema. */
const NO_VALUE = Symbol("no-value");

/** The declared example/default/enum for a schema, or {@link NO_VALUE}. */
const explicitExample = (schema: SchemaLike): unknown => {
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  return NO_VALUE;
};

/** A placeholder value for a primitive (leaf) schema. */
const primitiveExample = (
  types: string[],
  format: string | undefined
): unknown => {
  if (types.includes("number") || types.includes("integer")) {
    return 0;
  }
  if (types.includes("boolean")) {
    return true;
  }
  if (format === "date-time") {
    return "2024-01-01T00:00:00Z";
  }
  return format ? `<${format}>` : "string";
};

/**
 * Build a representative example value for a schema (honoring `example` /
 * `default` / `enum` first). A `seen` set of `$ref`s guards against the circular
 * schemas that keeping refs intact allows.
 */
export const exampleValue = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  seen = new Set<string>()
): unknown => {
  if (!schema) {
    return null;
  }
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) {
      return null;
    }
    seen.add(schema.$ref);
    return exampleValue(resolveSchema(schemas, schema), schemas, seen);
  }
  const explicit = explicitExample(schema);
  if (explicit !== NO_VALUE) {
    return explicit;
  }
  const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (branch) {
    return exampleValue(branch, schemas, seen);
  }
  const types = nonNullTypes(schema.type);
  if (types.includes("array")) {
    return [exampleValue(schema.items, schemas, seen)];
  }
  if (types.includes("object") || schema.properties || schema.allOf) {
    const out: Record<string, unknown> = {};
    for (const [name, prop] of objectProperties(schema, schemas).properties) {
      out[name] = exampleValue(prop, schemas, new Set(seen));
    }
    return out;
  }
  return primitiveExample(types, schema.format);
};

/** Pretty-print a JSON value for an example/code block. */
export const toJson = (value: unknown): string =>
  JSON.stringify(value, null, 2);
