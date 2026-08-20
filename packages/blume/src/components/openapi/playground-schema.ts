import { resolveSchema } from "./helpers.ts";
import type { SchemaLike, SpecValue } from "./helpers.ts";
import type { ValidationSchema } from "./request.ts";

/**
 * Spec-schema lowering shared by both playground models — the HTTP request
 * model (`operation-model.ts`) and the event message model
 * (`message-model.ts`). Both need the same three things from a spec schema: a
 * short type label for an input, a stringified default, and a pruned schema
 * the client-side validator understands. Keeping them here is what lets the
 * OpenAPI and AsyncAPI panels behave identically on the parts that are
 * genuinely identical.
 */

// `typeof` checks live in named predicates (the form the oxlint anti-slop
// config sanctions), mirroring the private guard in `helpers.ts`.
const isString = (value: SpecValue): value is string =>
  typeof value === "string";

/** A schema's declared non-null type names (3.1 arrays flattened). */
export const declaredTypes = (
  type: string | string[] | undefined
): string[] => {
  if (!type) {
    return [];
  }
  return (Array.isArray(type) ? type : [type]).filter(
    (entry) => entry !== "null"
  );
};

/** Short input-type label for a schema, resolved one `$ref` level: "string" default. */
export const scalarType = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>
): string => declaredTypes(resolveSchema(schemas, schema).type)[0] ?? "string";

/**
 * Stringify a precomputed default for a form input. Empty string means "no
 * default"; non-string primitives round-trip through JSON so booleans and
 * numbers read back exactly.
 */
export const inputValue = (value: SpecValue): string => {
  if (value === undefined || value === null) {
    return "";
  }
  return isString(value) ? value : JSON.stringify(value);
};

/** Recursion limit for pruned validation schemas — deep enough for real specs. */
const MAX_SCHEMA_DEPTH = 6;

/**
 * Prune a spec schema into the tiny subset `validate-json.ts` understands:
 * `$ref`s resolved inline, cycles cut (the visited set is copied per branch so
 * a ref reused by siblings still prunes fully), depth capped. Structure beyond
 * the cut simply goes unvalidated — advisory checks, not a gate.
 */
const pruneSchema = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  depth: number,
  seen: ReadonlySet<string>
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
  const resolved = resolveSchema(schemas, schema);
  const out: ValidationSchema = {};
  const [type] = declaredTypes(resolved.type);
  if (type) {
    out.type = type;
  }
  if (resolved.enum) {
    out.enum = resolved.enum;
  }
  if (resolved.required && resolved.required.length > 0) {
    out.required = resolved.required;
  }
  if (resolved.properties) {
    const properties: Record<string, ValidationSchema> = {};
    for (const [name, property] of Object.entries(resolved.properties)) {
      const pruned = pruneSchema(property, schemas, depth + 1, visited);
      if (pruned) {
        properties[name] = pruned;
      }
    }
    if (Object.keys(properties).length > 0) {
      out.properties = properties;
    }
  }
  if (resolved.items) {
    out.items = pruneSchema(resolved.items, schemas, depth + 1, visited);
  }
  return out;
};

/** The validator-ready view of a spec schema; undefined when there is none. */
export const validationSchema = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>
): ValidationSchema | undefined => pruneSchema(schema, schemas, 0, new Set());
