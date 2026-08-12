import type { ValidationSchema } from "./request.ts";

/**
 * Minimal JSON-schema validation for the playground body editor. Client-safe
 * and dependency-free by design: the server prunes the operation's schema into
 * the tiny `ValidationSchema` subset (`operation-model.ts`), so a full
 * draft-2020 validator would be dead weight in the browser bundle. Checks are
 * advisory — they catch the common "typo'd a required field" mistakes, they do
 * not gate the Send button.
 */

/** A human-readable name for a value's actual type, for mismatch messages. */
const describeValue = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
};

/** Whether `value` satisfies a schema `type` keyword; unknown keywords pass. */
const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case "object": {
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    }
    case "array": {
      return Array.isArray(value);
    }
    case "string": {
      return typeof value === "string";
    }
    case "number": {
      return typeof value === "number";
    }
    case "integer": {
      return typeof value === "number" && Number.isInteger(value);
    }
    case "boolean": {
      return typeof value === "boolean";
    }
    default: {
      // A keyword the pruned subset doesn't model (e.g. "null"): no opinion.
      return true;
    }
  }
};

const walk = (
  value: unknown,
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
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in record)) {
        errors.push(`${path}.${name} is required`);
      }
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (name in record) {
        walk(record[name], property, `${path}.${name}`, errors);
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
 * checked.
 */
export const validateJson = (
  text: string,
  schema?: ValidationSchema
): string[] => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return [
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const errors: string[] = [];
  walk(value, schema, "body", errors);
  return errors;
};
