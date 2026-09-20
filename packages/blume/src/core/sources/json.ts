/**
 * The JSON a CMS API returns: arbitrary values a query or REST endpoint
 * hands back, typed as a closed union so a source narrows with predicates
 * instead of casting.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object: a document, a node in a rich-text tree, an API envelope. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * A node a dot path can descend into. Arrays pass too (matching their runtime
 * string-key indexing, e.g. `items.0`), so the predicate types them as the
 * keyed form both traverse through.
 */
export const isJsonObject = (
  value: JsonValue | undefined
): value is JsonObject => typeof value === "object" && value !== null;

/** Resolve a dot path (`slug.current`) against a document. */
export const getPath = (
  doc: JsonObject,
  path: string
): JsonValue | undefined => {
  let current: JsonValue | undefined = doc;
  for (const key of path.split(".")) {
    if (isJsonObject(current)) {
      current = current[key];
    } else {
      return;
    }
  }
  return current;
};

export const isStringValue = (value: JsonValue | undefined): value is string =>
  typeof value === "string";

export const asString = (value: JsonValue | undefined): string | undefined =>
  isStringValue(value) ? value : undefined;

/** The elements of an array value, or none when the value is not an array. */
export const asArray = (value: JsonValue | undefined): JsonValue[] =>
  Array.isArray(value) ? value : [];

/** The object form of a value, or none when it is a scalar, array, or absent. */
export const asObject = (
  value: JsonValue | undefined
): JsonObject | undefined =>
  isJsonObject(value) && !Array.isArray(value) ? value : undefined;

export const isNumberValue = (value: JsonValue | undefined): value is number =>
  typeof value === "number";

export const asNumber = (value: JsonValue | undefined): number | undefined =>
  isNumberValue(value) ? value : undefined;

/** The object elements of an array value; scalars and nested arrays are dropped. */
export const objectsIn = (value: JsonValue | undefined): JsonObject[] =>
  asArray(value).flatMap((item) => {
    const object = asObject(item);
    return object ? [object] : [];
  });
