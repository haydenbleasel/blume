import type { ValidationSchema } from "./request.ts";

/**
 * Minimal JSON-schema validation for the playground body editor. Client-safe
 * and dependency-free by design: the server prunes the operation's schema into
 * the tiny `ValidationSchema` subset (`operation-model.ts`), so a full
 * draft-2020 validator would be dead weight in the browser bundle. Checks are
 * advisory — they catch the common "typo'd a required field" mistakes, they do
 * not gate the Send button.
 */

/** An already-parsed JSON object — string keys, parsed-JSON values. */
interface JsonObject {
  [key: string]: JsonValue;
}

/** Already-parsed JSON — everything `JSON.parse` can produce. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

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
    default: {
      // A keyword the pruned subset doesn't model (e.g. "null"): no opinion.
      return true;
    }
  }
};

const walk = (
  value: JsonValue,
  schema: ValidationSchema | undefined,
  path: string,
  errors: string[]
): void => {
  if (!schema) {
    return;
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    // Deeper checks against a wrong-shaped value would only produce noise.
    errors.push(
      `${path} should be ${schema.type}, got ${describeValue(value)}`
    );
    return;
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some(
      (member) => JSON.stringify(member) === JSON.stringify(value)
    )
  ) {
    errors.push(
      `${path} must be one of: ${schema.enum
        .map((member) => JSON.stringify(member))
        .join(", ")}`
    );
  }
  if (isJsonObject(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) {
        errors.push(`${path}.${name} is required`);
      }
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (name in value) {
        // SAFETY: `name in value` above proves the key exists, and parsed
        // JSON never holds `undefined` — the lookup is always a `JsonValue`
        // that `noUncheckedIndexedAccess` alone cannot see.
        walk(value[name] as JsonValue, property, `${path}.${name}`, errors);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      walk(item, schema.items, `${path}[${index}]`, errors);
    }
  }
};

/**
 * Validate raw JSON text against a pruned schema. Returns human-readable
 * error messages; an empty array means valid. With no schema, only syntax is
 * checked. `root` names the value in those messages — the HTTP panel edits a
 * `body`, the event composer a `payload`.
 */
export const validateJson = (
  text: string,
  schema?: ValidationSchema,
  root = "body"
): string[] => {
  // `JSON.parse` returns `any`; `JsonValue` is exactly its possible outputs.
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return [
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const errors: string[] = [];
  walk(value, schema, root, errors);
  return errors;
};
