import type { ValidationSchema } from "./request.ts";
import type { ReferenceStrings } from "./strings.ts";

/**
 * Minimal JSON-schema validation for the playground body editor. Client-safe
 * and dependency-free by design: the server prunes the operation's schema into
 * the tiny `ValidationSchema` subset (`operation-model.ts`), so a full
 * draft-2020 validator would be dead weight in the browser bundle. The checks
 * catch the common "typo'd a required field" mistakes and values that break
 * a `oneOf`, `anyOf`, or `not`, and any error they report blocks the Try it
 * send (`playground-client.ts`) and the event composer's connect and send
 * (`message-composer.ts`). The server runs the same checks on the examples
 * it generates (`exampleValue` in `helpers.ts`), so it never shows one the
 * schema rejects.
 */

/**
 * The messages a failed check reports, in the page's language. The panel
 * reads them from its server-rendered markup, so this module stays free of
 * the dictionaries.
 */
export type ValidationStrings = Pick<
  ReferenceStrings,
  | "invalidJson"
  | "notAllowed"
  | "requiredMissing"
  | "schemaMismatch"
  | "wrongType"
>;

/** An already-parsed JSON object — string keys, parsed-JSON values. */
interface JsonObject {
  [key: string]: JsonValue;
}

/** Already-parsed JSON — everything `JSON.parse` can produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

// `typeof` checks live in named predicates (the form the oxlint anti-slop
// config sanctions); each narrows the parsed-JSON union at its call site.
const isString = (value: JsonValue): value is string =>
  typeof value === "string";

const isNumber = (value: JsonValue): value is number =>
  typeof value === "number";

const isBoolean = (value: JsonValue): value is boolean =>
  typeof value === "boolean";

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A human-readable name for a value's actual type, for mismatch messages. */
const describeValue = (value: JsonValue): string => {
  if (value === null) {
    return "null";
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- typeof's result string is itself the human-readable label here, not a narrowing check
  return Array.isArray(value) ? "array" : typeof value;
};

/** Whether `value` satisfies a schema `type` keyword; unknown keywords pass. */
const matchesType = (value: JsonValue, type: string): boolean => {
  switch (type) {
    case "object": {
      return isJsonObject(value);
    }
    case "array": {
      return Array.isArray(value);
    }
    case "string": {
      return isString(value);
    }
    case "number": {
      return isNumber(value);
    }
    case "integer": {
      return isNumber(value) && Number.isInteger(value);
    }
    case "boolean": {
      return isBoolean(value);
    }
    case "null": {
      return value === null;
    }
    default: {
      // A keyword the pruned subset doesn't model: no opinion.
      return true;
    }
  }
};

/** Messages for a check whose verdict is all that matters. */
const SILENT: ValidationStrings = {
  invalidJson: "",
  notAllowed: "",
  requiredMissing: "",
  schemaMismatch: "",
  wrongType: "",
};

/** The allowed values `value` isn't among (its `enum`, else its `const`), as JSON. */
/**
 * A `JSON.stringify` replacer that sorts object keys, so two equal values
 * write the same text whatever order their keys came in.
 */
const sortedKeys = (_key: string, member: JsonValue): JsonValue =>
  isJsonObject(member)
    ? Object.fromEntries(
        Object.entries(member).toSorted(([a], [b]) => (a < b ? -1 : 1))
      )
    : member;

const disallowed = (
  value: JsonValue,
  schema: ValidationSchema
): string | undefined => {
  const text = JSON.stringify(value, sortedKeys);
  if (
    schema.enum !== undefined &&
    !schema.enum.some((member) => JSON.stringify(member, sortedKeys) === text)
  ) {
    return schema.enum.map((member) => JSON.stringify(member)).join(", ");
  }
  return schema.const === undefined ||
    JSON.stringify(schema.const, sortedKeys) === text
    ? undefined
    : JSON.stringify(schema.const);
};

/**
 * Whether a value breaks its schema's `oneOf` (exactly one variant must
 * match), `anyOf` (at least one), or `not` (none), given which variants it
 * `passes`. A variant's own errors would only say why it isn't the one.
 */
const mismatched = (
  schema: ValidationSchema,
  passes: (variant: ValidationSchema) => boolean
): boolean => {
  const matching = (variants: ValidationSchema[]): number =>
    variants.filter(passes).length;
  return (
    (schema.oneOf !== undefined && matching(schema.oneOf) !== 1) ||
    (schema.anyOf !== undefined && matching(schema.anyOf) === 0) ||
    (schema.not !== undefined && passes(schema.not))
  );
};

const beyond = (size: number, min?: number, max?: number): boolean =>
  (min !== undefined && size < min) || (max !== undefined && size > max);

/**
 * Whether a number, string, or array falls outside its schema's bounds. A
 * `pattern` goes unchecked: the sampler writes `"string"` for a patterned
 * value, a placeholder the reader replaces, and can't build a string to
 * match most real patterns.
 */
const outOfBounds = (value: JsonValue, schema: ValidationSchema): boolean => {
  if (isNumber(value)) {
    return (
      beyond(value, schema.minimum, schema.maximum) ||
      (schema.exclusiveMinimum !== undefined &&
        value <= schema.exclusiveMinimum) ||
      (schema.exclusiveMaximum !== undefined &&
        value >= schema.exclusiveMaximum)
    );
  }
  if (isString(value)) {
    return beyond([...value].length, schema.minLength, schema.maxLength);
  }
  return (
    Array.isArray(value) &&
    beyond(value.length, schema.minItems, schema.maxItems)
  );
};

/** The members of an object or array, each with its schema and its path. */
const members = (
  value: JsonValue,
  schema: ValidationSchema,
  path: string
): [JsonValue, ValidationSchema | undefined, string][] => {
  if (isJsonObject(value)) {
    return Object.entries(value).map(([name, member]) => [
      member,
      schema.properties?.[name] ?? schema.additionalProperties,
      `${path}.${name}`,
    ]);
  }
  return Array.isArray(value)
    ? value.map((item, index) => [item, schema.items, `${path}[${index}]`])
    : [];
};

const walk = (
  value: JsonValue,
  schema: ValidationSchema | undefined,
  path: string,
  errors: string[],
  strings: ValidationStrings
): void => {
  if (!schema || (value === null && schema.nullable === true)) {
    return;
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    // Deeper checks against a wrong-shaped value would only produce noise.
    const expected = schema.type;
    errors.push(
      strings.wrongType
        .replaceAll("{path}", () => path)
        .replaceAll("{expected}", () => expected)
        .replaceAll("{actual}", () => describeValue(value))
    );
    return;
  }
  const values = disallowed(value, schema);
  if (values !== undefined) {
    errors.push(
      strings.notAllowed
        .replaceAll("{path}", () => path)
        .replaceAll("{values}", () => values)
    );
  }
  for (const member of schema.allOf ?? []) {
    walk(value, member, path, errors, strings);
  }
  const passes = (variant: ValidationSchema): boolean => {
    const found: string[] = [];
    walk(value, variant, path, found, SILENT);
    return found.length === 0;
  };
  if (mismatched(schema, passes) || outOfBounds(value, schema)) {
    errors.push(strings.schemaMismatch.replaceAll("{path}", () => path));
  }
  if (isJsonObject(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) {
        errors.push(
          strings.requiredMissing.replaceAll("{path}", () => `${path}.${name}`)
        );
      }
    }
  }
  for (const [member, memberSchema, memberPath] of members(
    value,
    schema,
    path
  )) {
    walk(member, memberSchema, memberPath, errors, strings);
  }
};

/** Whether an already-parsed value passes every check of a pruned schema. */
export const matchesSchema = (
  value: JsonValue,
  schema: ValidationSchema | undefined
): boolean => {
  const errors: string[] = [];
  walk(value, schema, "", errors, SILENT);
  return errors.length === 0;
};

/**
 * Validate raw JSON text against a pruned schema. Returns human-readable
 * error messages; an empty array means valid. With no schema, only syntax is
 * checked. `root` names the value in those messages — the HTTP panel edits a
 * `body`, the event composer a `payload`.
 */
export const validateJson = (
  text: string,
  strings: ValidationStrings,
  schema?: ValidationSchema,
  root = "body"
): string[] => {
  // `JSON.parse` returns `any`; `JsonValue` is exactly its possible outputs.
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [strings.invalidJson.replaceAll("{error}", () => detail)];
  }
  const errors: string[] = [];
  walk(value, schema, root, errors, strings);
  return errors;
};
