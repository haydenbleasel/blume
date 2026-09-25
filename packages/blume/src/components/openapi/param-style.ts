/**
 * OpenAPI 3 parameter serialization — `style` and `explode` — for the
 * playground's one request builder (`request.ts`). An array or object value
 * has a different wire shape per style: `tags: ["dog", "cat"]` is
 * `tags=dog&tags=cat` in a query (form, exploded), `dog,cat` in a path
 * (simple), and `filter: { color: "red" }` is `filter[color]=red` as a
 * deepObject. Ships in the client bundle with `request.ts`, so it stays
 * dependency-free.
 */

/** Parsed JSON: everything `JSON.parse` can produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A value lowered for serialization: a scalar, a list's items, or an object's entries. */
export type StyledValue =
  | { kind: "scalar"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "object"; entries: [string, string][] };

// `typeof` checks live in named predicates (the form the oxlint anti-slop
// config sanctions).
const isString = (value: JsonValue): value is string =>
  typeof value === "string";

/** Whether a parsed value is a plain JSON object. */
export const isJsonObject = (
  value: JsonValue
): value is { [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One member as wire text: a string verbatim, anything else as its JSON. */
export const memberText = (value: JsonValue): string =>
  isString(value) ? value : JSON.stringify(value);

/** A parsed value, lowered: arrays to items, objects to entries, the rest to text. */
export const styledValue = (value: JsonValue): StyledValue => {
  if (Array.isArray(value)) {
    return { items: value.map(memberText), kind: "list" };
  }
  if (isJsonObject(value)) {
    return {
      entries: Object.entries(value).map(([key, member]) => [
        key,
        memberText(member),
      ]),
      kind: "object",
    };
  }
  return { kind: "scalar", text: memberText(value) };
};

/**
 * A playground input's text as a styled value. Only an array- or object-typed
 * parameter reads its text as JSON — its prefill is the example's JSON
 * (`["dog","cat"]`) — and only when the text parses to that shape; anything
 * else is sent as the one scalar it reads as.
 */
export const parseStyledValue = (text: string, type: string): StyledValue => {
  if (type === "array" || type === "object") {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "scalar", text };
    }
    if (type === "array" ? Array.isArray(parsed) : isJsonObject(parsed)) {
      return styledValue(parsed);
    }
  }
  return { kind: "scalar", text };
};

/** The OpenAPI 3 default style: `form` in a query or cookie, `simple` elsewhere. */
export const defaultStyle = (location: string): string =>
  location === "query" || location === "cookie" ? "form" : "simple";

/** `explode` when the spec leaves it out: true for `form`, false for the rest. */
export const defaultExplode = (style: string): boolean => style === "form";

/**
 * A list or object joined into one value: exploded object entries as
 * `key=value` separated by `separator`, exploded items by `separator`, and
 * the unexploded forms comma-separated (`a,b`, `key,value,key2,value2`).
 */
const joined = (
  value: StyledValue,
  explode: boolean,
  encode: (text: string) => string,
  separator: string
): string => {
  if (value.kind === "scalar") {
    return encode(value.text);
  }
  if (value.kind === "list") {
    return value.items.map(encode).join(explode ? separator : ",");
  }
  return explode
    ? value.entries
        .map(([key, member]) => `${encode(key)}=${encode(member)}`)
        .join(separator)
    : value.entries.flat().map(encode).join(",");
};

/**
 * A query parameter, or an `application/x-www-form-urlencoded` body field, as
 * its percent-encoded `name=value` pairs in order. Exploded lists repeat the
 * name (`tags=dog&tags=cat`) and exploded objects spread their entries
 * (`color=red&size=L`) whatever the style; unexploded ones join with the
 * style's delimiter — `,` for form, `%20` for spaceDelimited, `|` for
 * pipeDelimited. deepObject nests entries under the name (`filter[color]=red`).
 */
export const queryPairs = (
  name: string,
  value: StyledValue,
  style: string,
  explode: boolean
): string[] => {
  const key = encodeURIComponent(name);
  if (value.kind === "object" && style === "deepObject") {
    return value.entries.map(
      ([entry, member]) =>
        `${key}[${encodeURIComponent(entry)}]=${encodeURIComponent(member)}`
    );
  }
  if (value.kind === "list" && explode) {
    return value.items.map((item) => `${key}=${encodeURIComponent(item)}`);
  }
  if (value.kind === "object" && explode) {
    return value.entries.map(
      ([entry, member]) =>
        `${encodeURIComponent(entry)}=${encodeURIComponent(member)}`
    );
  }
  let delimiter = ",";
  if (style === "spaceDelimited") {
    delimiter = "%20";
  } else if (style === "pipeDelimited") {
    delimiter = "|";
  }
  const text =
    value.kind === "scalar"
      ? encodeURIComponent(value.text)
      : (value.kind === "list" ? value.items : value.entries.flat())
          .map(encodeURIComponent)
          .join(delimiter);
  return [`${key}=${text}`];
};

/**
 * A path or header parameter's value: `simple` (`dog,cat`), or one of the
 * path-only `label` (`.dog.cat`) and `matrix` (`;tags=dog;tags=cat`) styles.
 * `encode` percent-encodes a path segment; a header passes values through.
 */
export const templateValue = (
  name: string,
  value: StyledValue,
  style: string,
  explode: boolean,
  encode: (text: string) => string
): string => {
  if (style === "label") {
    return `.${joined(value, explode, encode, ".")}`;
  }
  if (style !== "matrix") {
    return joined(value, explode, encode, ",");
  }
  const key = encode(name);
  if (value.kind === "list" && explode) {
    return value.items.map((item) => `;${key}=${encode(item)}`).join("");
  }
  if (value.kind === "object" && explode) {
    return `;${joined(value, true, encode, ";")}`;
  }
  return `;${key}=${joined(value, false, encode, ",")}`;
};
