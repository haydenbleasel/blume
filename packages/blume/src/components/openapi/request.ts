import {
  defaultExplode,
  defaultStyle,
  isJsonObject,
  memberText,
  parseStyledValue,
  queryPairs,
  styledValue,
  templateValue,
} from "./param-style.ts";
import type { JsonValue } from "./param-style.ts";
import type { RequestSample } from "./snippets.ts";

/**
 * Framework-free request model for the "Try it" playground. This module ships
 * in the client bundle, so it must stay dependency-free: parameter and body
 * examples are precomputed server-side (`operation-model.ts`) and embedded in
 * the model JSON — nothing here touches openapi-sampler or the spec document.
 * `buildRequest` is THE one request builder: the code samples, the copy
 * buttons, and the live fetch all consume its output, so what readers see is
 * byte-for-byte what gets sent.
 */

/**
 * How a parameter or form-body field serializes, as far as the spec says:
 * the request builder applies the OpenAPI defaults for what it leaves out.
 */
export interface ParamSerialization {
  /** The spec's `style`; else the location's default. */
  style?: string;
  /** The spec's `explode`; else the style's default. */
  explode?: boolean;
}

export interface PlaygroundParam extends ParamSerialization {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  /** Short type label for the input: "string" | "number" | "integer" | "boolean" | ... */
  type: string;
  /** Enum members stringified, when the schema declares them. */
  enum?: string[];
  /** Precomputed default from spec example/sampler; "" when none (optional params default ""). */
  value: string;
}

export interface PlaygroundBodyField {
  name: string;
  required: boolean;
  description?: string;
  /** Primitive type name; the client coerces number/integer/boolean. */
  type: string;
  enum?: string[];
  /** Stringified default, "" when none. */
  value: string;
}

/** A pruned, cycle-free JSON-schema subset `validate-json.ts` understands. */
export interface ValidationSchema {
  type?: string;
  /** `null` is also accepted: 3.0 `nullable`, or `"null"` in a 3.1 type array. */
  nullable?: boolean;
  properties?: Record<string, ValidationSchema>;
  required?: string[];
  items?: ValidationSchema;
  enum?: unknown[];
}

export interface PlaygroundBody {
  contentType: string;
  /** Present when the schema is a flat object of primitives -> typed fields UI. */
  fields?: PlaygroundBodyField[];
  /**
   * Prefill for the raw editor: pretty-printed example JSON, or a raw media
   * type's (`text/plain`, XML) string example verbatim; "" when none.
   */
  example: string;
  schema?: ValidationSchema;
  /** A form-urlencoded body's per-field `encoding` (`style`/`explode`). */
  encoding?: Record<string, ParamSerialization>;
}

export type AuthKind = "bearer" | "basic" | "apiKey" | "oauth2";

export interface PlaygroundAuthInput {
  /** SecurityScheme component key. */
  id: string;
  kind: AuthKind;
  /** `schemeLabel()` output. */
  label: string;
  carrier: { in: "header" | "query" | "cookie"; name: string };
  /** Placeholder credential used in redacted samples, e.g. "YOUR_TOKEN". */
  placeholder: string;
  /** Header value prefix, e.g. "Bearer " ("" for apiKey). Basic uses "Basic ". */
  prefix: string;
}

export interface PlaygroundModel {
  /** Upper-case HTTP method. */
  method: string;
  /** Templated path, e.g. `/pets/{id}`. */
  path: string;
  /** Spec servers in order; first is the default base. */
  servers: string[];
  params: PlaygroundParam[];
  body?: PlaygroundBody;
  /** First security alternative (AND set). */
  auth: PlaygroundAuthInput[];
  authOptional: boolean;
}

export interface AuthValue {
  value: string;
  username?: string;
  password?: string;
}

export interface RequestValues {
  /** Resolved base URL (custom override already applied). */
  server: string;
  /** Key: `paramKey(param)`. */
  params: Record<string, string>;
  /** Raw JSON text; undefined = no body. */
  body?: string;
  /** Key: `PlaygroundAuthInput.id`. */
  auth: Record<string, AuthValue>;
}

export const paramKey = (p: { in: string; name: string }): string =>
  `${p.in}:${p.name}`;

/**
 * The request header a proxied send names the headers the playground set in,
 * comma-separated. Blume's built-in proxy forwards those and nothing else, so
 * credentials the browser attaches on its own — HTTP Basic auth for a docs
 * site behind a password, platform headers added in front of the docs server
 * — never reach the documented API.
 */
export const PROXY_HEADERS_HEADER = "X-Blume-Proxy-Headers";

/**
 * How a body's media type is put on the wire: JSON as the editor text,
 * `application/x-www-form-urlencoded` as `name=value` pairs, and
 * `multipart/form-data` as form parts — both from the editor's JSON object —
 * and any other type (`text/plain`, XML) as the raw text.
 */
export type BodyEncoding = "json" | "form" | "multipart" | "raw";

/** A `+json` suffix or a `json` subtype: `application/json`, `application/vnd.api+json`. */
const JSON_MEDIA_TYPE = /[+/]json$/u;

/** The {@link BodyEncoding} a body's media type (parameters ignored) takes. */
export const bodyEncoding = (contentType: string): BodyEncoding => {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    return "form";
  }
  if (type === "multipart/form-data") {
    return "multipart";
  }
  return JSON_MEDIA_TYPE.test(type) ? "json" : "raw";
};

/** Values pre-filled from the model's precomputed examples; auth entries empty. */
export const defaultValues = (model: PlaygroundModel): RequestValues => ({
  auth: Object.fromEntries(
    model.auth.map((input) => [input.id, { value: "" }])
  ),
  body: model.body ? model.body.example : undefined,
  params: Object.fromEntries(
    model.params.map((param) => [paramKey(param), param.value])
  ),
  server: model.servers[0] ?? "",
});

/** Copy of `values` with every auth value emptied (redacted) so samples show placeholders. */
export const redactAuth = (
  model: PlaygroundModel,
  values: RequestValues
): RequestValues => ({
  ...values,
  auth: Object.fromEntries(
    model.auth.map((input) => [input.id, { value: "" }])
  ),
});

const TRAILING_SLASH = /\/+$/u;

/**
 * Base64 of `text`'s UTF-8 bytes. `btoa` alone throws on any code point above
 * U+00FF, so a credential with non-Latin-1 characters (a Cyrillic username, an
 * emoji in a password) would take down every sample render; RFC 7617 names
 * UTF-8 as the charset to encode a `user:password` pair in.
 */
const base64Utf8 = (text: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

/**
 * The credential a request carries for one auth input: the user's value when
 * present, else the redaction placeholder. Basic auth encodes user:password
 * per RFC 7617 — the placeholder stands in until either field is filled.
 */
const credentialFor = (
  input: PlaygroundAuthInput,
  auth: AuthValue | undefined
): string => {
  if (input.kind === "basic") {
    const username = auth?.username ?? "";
    const password = auth?.password ?? "";
    return username !== "" || password !== ""
      ? base64Utf8(`${username}:${password}`)
      : input.placeholder;
  }
  const value = auth?.value ?? "";
  return value === "" ? input.placeholder : value;
};

/**
 * Apply the model's auth inputs to the outgoing query/headers. Query-borne
 * credentials skip names an explicit query parameter already contributed (the
 * spec's example wins); cookie-borne ones collapse into a single `Cookie`
 * header, matching how browsers send them.
 */
const applyAuth = (
  model: PlaygroundModel,
  values: RequestValues,
  seen: ReadonlySet<string>,
  query: string[],
  headers: Record<string, string>
): void => {
  const cookies: string[] = [];
  for (const input of model.auth) {
    const credential = credentialFor(input, values.auth[input.id]);
    if (input.carrier.in === "query") {
      if (!seen.has(input.carrier.name)) {
        query.push(
          `${encodeURIComponent(input.carrier.name)}=${encodeURIComponent(
            credential
          )}`
        );
      }
    } else if (input.carrier.in === "cookie") {
      cookies.push(`${input.carrier.name}=${credential}`);
    } else {
      headers[input.carrier.name] = `${input.prefix}${credential}`;
    }
  }
  if (cookies.length > 0) {
    headers.Cookie = cookies.join("; ");
  }
};

/**
 * A form-urlencoded body's `name=value` pairs: each field serialized like a
 * query parameter, under the `encoding` the spec declares for it (`form`,
 * exploded, by default — so a list repeats its name).
 */
const urlencodedBody = (
  value: { [key: string]: JsonValue },
  encoding: PlaygroundBody["encoding"]
): string =>
  Object.entries(value)
    .flatMap(([name, member]) => {
      const style = encoding?.[name]?.style ?? "form";
      return queryPairs(
        name,
        styledValue(member),
        style,
        encoding?.[name]?.explode ?? defaultExplode(style)
      );
    })
    .join("&");

/** Multipart form parts in order: a list contributes one part per item. */
const multipartParts = (value: {
  [key: string]: JsonValue;
}): [string, string][] =>
  Object.entries(value).flatMap(([name, member]) =>
    Array.isArray(member)
      ? member.map((item): [string, string] => [name, memberText(item)])
      : [[name, memberText(member)]]
  );

/**
 * The editor text serialized for the body's media type, with a parsed mirror
 * when it is valid JSON. A form body is built from the editor's JSON object;
 * text that isn't one (mid-edit, or a raw media type) is sent as written.
 */
const bodyFor = (
  body: PlaygroundBody,
  text: string | undefined
): Pick<RequestSample, "body" | "bodyValue" | "formData"> => {
  if (text === undefined || text === "") {
    return {};
  }
  const encoding = bodyEncoding(body.contentType);
  if (encoding === "raw") {
    return { body: text };
  }
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    // Not valid JSON (mid-edit): still send it — the structured mirror is
    // only a nicety for consumers of `bodyValue`.
    return { body: text };
  }
  if (encoding === "json" || !isJsonObject(value)) {
    return { body: text, bodyValue: value };
  }
  return encoding === "form"
    ? { body: urlencodedBody(value, body.encoding), bodyValue: value }
    : { bodyValue: value, formData: multipartParts(value) };
};

/**
 * A path or header parameter's value under its `style`: an array or object
 * parameter's JSON text becomes `dog,cat` (simple), `.dog.cat` (label), or
 * `;tags=dog;tags=cat` (matrix) rather than its JSON.
 */
const styledParam = (
  param: PlaygroundParam,
  value: string,
  encode: (text: string) => string
): string => {
  const style = param.style ?? defaultStyle(param.in);
  return templateValue(
    param.name,
    parseStyledValue(value, param.type),
    style,
    param.explode ?? defaultExplode(style),
    encode
  );
};

/**
 * The model's path with each `{param}` filled in. An empty value substitutes
 * the raw param name, so a blank form still renders a readable templated URL
 * instead of `//`.
 */
const resolvePath = (model: PlaygroundModel, values: RequestValues): string => {
  let resolved = model.path;
  for (const param of model.params) {
    if (param.in !== "path") {
      continue;
    }
    const value = values.params[paramKey(param)] ?? "";
    resolved = resolved.replace(
      `{${param.name}}`,
      value === "" ? param.name : styledParam(param, value, encodeURIComponent)
    );
  }
  return resolved;
};

/**
 * The query parameters' `name=value` pairs in model order, each name added to
 * `seen` so a query-borne credential can defer to it.
 */
const queryParams = (
  model: PlaygroundModel,
  values: RequestValues,
  seen: Set<string>
): string[] => {
  const query: string[] = [];
  for (const param of model.params) {
    if (param.in !== "query") {
      continue;
    }
    const value = values.params[paramKey(param)] ?? "";
    // A required param stays visible even when blank (`filter=`) — silently
    // dropping it would make the samples deny the parameter exists. Optional
    // blanks drop out entirely.
    if (value === "" && !param.required) {
      continue;
    }
    seen.add(param.name);
    const style = param.style ?? defaultStyle(param.in);
    query.push(
      ...queryPairs(
        param.name,
        parseStyledValue(value, param.type),
        style,
        param.explode ?? defaultExplode(style)
      )
    );
  }
  return query;
};

/** THE one request builder: samples, copy buttons, and fetch all consume its output. */
export const buildRequest = (
  model: PlaygroundModel,
  values: RequestValues
): RequestSample => {
  // The server's trailing slash only goes when a path is joined onto it: a
  // GraphQL endpoint (no path) is sent exactly as configured, and
  // `https://host/graphql/` is not always the same route as `…/graphql`.
  const base =
    model.path === ""
      ? values.server
      : values.server.replace(TRAILING_SLASH, "");

  // Query params with a value contribute in model order; a query-borne auth
  // credential appends after — unless the spec also declares that name as an
  // explicit query parameter, whose (better) example wins.
  const seen = new Set<string>();
  const query = queryParams(model, values, seen);

  // Auth first, so a spec that also declares the credential as an explicit
  // header parameter overrides it below with its own (better) example.
  const headers: Record<string, string> = {};
  applyAuth(model, values, seen, query, headers);
  for (const param of model.params) {
    if (param.in !== "header") {
      continue;
    }
    const value = values.params[paramKey(param)] ?? "";
    // Required headers emit even when blank, mirroring the query rule above —
    // except a blank one never clobbers a credential auth already placed
    // under the same name.
    if (value !== "") {
      headers[param.name] = styledParam(param, value, (text) => text);
    } else if (param.required && headers[param.name] === undefined) {
      headers[param.name] = value;
    }
  }

  const { body, bodyValue, formData } = model.body
    ? bodyFor(model.body, values.body)
    : {};
  // Multipart parts carry no Content-Type here: the client (curl, fetch,
  // requests) writes it along with the boundary that separates the parts.
  if (body !== undefined && model.body) {
    headers["Content-Type"] = model.body.contentType;
  }

  const search = query.length > 0 ? `?${query.join("&")}` : "";
  return {
    body,
    bodyValue,
    formData,
    headers,
    method: model.method.toUpperCase(),
    url: `${base}${resolvePath(model, values)}${search}`,
  };
};
