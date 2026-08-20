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

export interface PlaygroundParam {
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
  properties?: Record<string, ValidationSchema>;
  required?: string[];
  items?: ValidationSchema;
  enum?: unknown[];
}

export interface PlaygroundBody {
  contentType: string;
  /** Present when the schema is a flat object of primitives -> typed fields UI. */
  fields?: PlaygroundBodyField[];
  /** Pretty-printed example JSON prefill for the raw editor; "" when none. */
  example: string;
  schema?: ValidationSchema;
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

/** The raw editor text to send, with a parsed mirror when it is valid JSON. */
const bodyFor = (
  text: string | undefined
): Pick<RequestSample, "body" | "bodyValue"> => {
  if (text === undefined || text === "") {
    return {};
  }
  try {
    return { body: text, bodyValue: JSON.parse(text) };
  } catch {
    // Not valid JSON (mid-edit or intentionally raw): still send it — the
    // structured mirror is only a nicety for consumers of `bodyValue`.
    return { body: text };
  }
};

/** THE one request builder: samples, copy buttons, and fetch all consume its output. */
export const buildRequest = (
  model: PlaygroundModel,
  values: RequestValues
): RequestSample => {
  const base = values.server.replace(TRAILING_SLASH, "");

  // Path params: an empty value substitutes the raw param name, so a blank
  // form still renders a readable templated URL instead of `//`.
  let resolvedPath = model.path;
  for (const param of model.params) {
    if (param.in !== "path") {
      continue;
    }
    const value = values.params[paramKey(param)] ?? "";
    resolvedPath = resolvedPath.replace(
      `{${param.name}}`,
      value === "" ? param.name : encodeURIComponent(value)
    );
  }

  // Query params with a value contribute in model order; a query-borne auth
  // credential appends after — unless the spec also declares that name as an
  // explicit query parameter, whose (better) example wins.
  const query: string[] = [];
  const seen = new Set<string>();
  for (const param of model.params) {
    if (param.in !== "query") {
      continue;
    }
    const value = values.params[paramKey(param)] ?? "";
    if (value === "") {
      continue;
    }
    seen.add(param.name);
    query.push(
      `${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`
    );
  }

  // Auth first, so a spec that also declares the credential as an explicit
  // header parameter overrides it below with its own (better) example.
  const headers: Record<string, string> = {};
  applyAuth(model, values, seen, query, headers);
  for (const param of model.params) {
    if (param.in !== "header") {
      continue;
    }
    const value = values.params[paramKey(param)] ?? "";
    if (value !== "") {
      headers[param.name] = value;
    }
  }

  const { body, bodyValue } = model.body ? bodyFor(values.body) : {};
  if (body !== undefined && model.body) {
    headers["Content-Type"] = model.body.contentType;
  }

  const search = query.length > 0 ? `?${query.join("&")}` : "";
  return {
    body,
    bodyValue,
    headers,
    method: model.method.toUpperCase(),
    url: `${base}${resolvedPath}${search}`,
  };
};
