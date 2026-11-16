import { resolveSchema } from "./helpers.ts";
import type { SchemaLike, SpecValue } from "./helpers.ts";

/**
 * Spec-schema lowering shared by both playground models — the HTTP request
 * model (`operation-model.ts`) and the event message model
 * (`message-model.ts`). Both need the same things from a spec schema: a short
 * type label for an input and a stringified default; the pruned schema the
 * client-side validator understands is `validationSchema` in `helpers.ts`,
 * which checks generated examples too. Keeping them here is what lets the
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
