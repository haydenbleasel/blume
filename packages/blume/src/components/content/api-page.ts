import { exampleValue } from "../openapi/helpers.ts";
import type { ParameterLike, SchemaLike } from "../openapi/helpers.ts";
import { resolveSecurity } from "../openapi/security.ts";
import type { OperationSecurity } from "../openapi/security.ts";
import type { FieldValue, ParamLocation } from "./api-field.ts";

/**
 * A hand-written API page's endpoint, as its `api` frontmatter and its
 * `<ParamField>`s describe it, turned into the OpenAPI-shaped pieces the
 * operation playground and code samples are built from: a page with
 * `api: "POST /v1/users"` gets the same Try it panel and request samples as
 * a spec'd operation, with no spec. Mintlify's frontmatter, so migrated pages
 * keep it as written.
 */

/** How a hand-written endpoint authenticates (`authMethod`, `api.auth.method`). */
export const AUTH_METHODS = ["bearer", "basic", "key", "none"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** What a page's playground shows: all of it, the samples only, or none. */
export const PLAYGROUND_MODES = ["interactive", "simple", "none"] as const;
export type PlaygroundMode = (typeof PLAYGROUND_MODES)[number];

/** `api` frontmatter: an HTTP method, then a path or a full URL. */
export const API_ENDPOINT =
  /^(?<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(?<target>\S+)$/iu;

/** The site's default auth for hand-written endpoints (`api.auth`). */
export interface EndpointAuth {
  method: AuthMethod;
  /** The header an API key goes in. */
  name?: string;
}

/** One `<ParamField>`, as the page's plugin collected it. */
export interface EndpointField {
  default?: FieldValue;
  deprecated?: boolean;
  /** Body fields nested in this one's `<Expandable>`. */
  fields?: EndpointField[];
  location: ParamLocation;
  name: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
}

/** What the page's plugin hands the endpoint components. */
export interface EndpointSpec {
  authMethod?: AuthMethod;
  fields: EndpointField[];
  method: string;
  playground?: PlaygroundMode;
  /** The page has a `<RequestExample>`, which stands in for generated samples. */
  requestExample: boolean;
  /** The `api` target as written: a path, or a full URL. */
  target: string;
}

/** The method and target of an `api` value, or `null` when it isn't one. */
export const parseApiEndpoint = (
  value: string
): { method: string; target: string } | null => {
  const groups = API_ENDPOINT.exec(value.trim())?.groups;
  return groups?.method && groups.target
    ? { method: groups.method.toUpperCase(), target: groups.target }
    : null;
};

const ABSOLUTE_URL = /^(?<origin>https?:\/\/[^/?#]+)(?<rest>.*)$/iu;

/** An endpoint's target, split the way the operation model takes it. */
export interface EndpointTarget {
  path: string;
  servers: { url: string }[];
}

/**
 * The target split into a server and a path: a full URL is its own server,
 * and a path joins the site's `api.server`, or stays relative to the docs
 * when there is none.
 */
export const endpointTarget = (
  target: string,
  server?: string
): EndpointTarget => {
  const absolute = ABSOLUTE_URL.exec(target)?.groups;
  if (absolute?.origin) {
    return {
      path: absolute.rest || "/",
      servers: [{ url: absolute.origin }],
    };
  }
  return {
    path: target.startsWith("/") ? target : `/${target}`,
    servers: server ? [{ url: server.replace(/\/+$/u, "") }] : [],
  };
};

const PRIMITIVES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
]);

/**
 * A field's JSON schema from its `type`: `string[]` an array of strings, a
 * field with nested fields an object with those properties, and anything
 * that isn't a JSON type (`enum<string>`, `Date`) a string, which is what it
 * goes over the wire as. A default and placeholder carry over, the
 * placeholder as the example the samples show.
 */
export const fieldSchema = (field: EndpointField): SchemaLike => {
  const type = field.type?.trim().toLowerCase() ?? "";
  if (type.endsWith("[]")) {
    return {
      items: fieldSchema({
        ...field,
        default: undefined,
        type: type.slice(0, -2),
      }),
      type: "array",
    };
  }
  const nested = field.fields ?? [];
  const schema: SchemaLike =
    nested.length > 0
      ? {
          properties: Object.fromEntries(
            nested.map((child) => [child.name, fieldSchema(child)])
          ),
          type: "object",
        }
      : { type: PRIMITIVES.has(type) ? type : "string" };
  const required = nested
    .filter((child) => child.required)
    .map((child) => child.name);
  if (required.length > 0) {
    schema.required = required;
  }
  if (field.default !== undefined) {
    schema.default = field.default;
  }
  if (field.placeholder) {
    schema.example = field.placeholder;
  }
  if (field.deprecated) {
    schema.deprecated = true;
  }
  return schema;
};

/** The path, query, and header fields as OpenAPI parameters. */
export const endpointParameters = (fields: EndpointField[]): ParameterLike[] =>
  fields.flatMap((field) =>
    field.location === "body"
      ? []
      : [
          {
            deprecated: field.deprecated === true,
            in: field.location,
            name: field.name,
            // A path parameter is always required.
            required: field.location === "path" || field.required === true,
            schema: fieldSchema(field),
          },
        ]
  );

/** Whether a field, or one nested in it, has a `default` or `placeholder`. */
const hasValue = (field: EndpointField): boolean =>
  field.default !== undefined ||
  Boolean(field.placeholder) ||
  (field.fields ?? []).some(hasValue);

/**
 * The fields a request starts with: required ones, and ones with a value to
 * send. An optional field with neither is left for the reader to fill,
 * rather than sent as the sampler's `"string"`, `0`, or `true`.
 */
const sentFields = (fields: EndpointField[]): EndpointField[] =>
  fields
    .filter((field) => field.required === true || hasValue(field))
    .map((field) => ({ ...field, fields: sentFields(field.fields ?? []) }));

/**
 * The body fields as a JSON request body, or `undefined` when there are none.
 * Its example, which the playground and samples start from, holds only the
 * {@link sentFields}.
 */
export const endpointBody = (fields: EndpointField[]) => {
  const body = fields.filter((field) => field.location === "body");
  const object = (members: EndpointField[]): SchemaLike =>
    fieldSchema({
      fields: members,
      location: "body",
      name: "",
      type: "object",
    });
  return body.length > 0
    ? {
        content: {
          "application/json": {
            example: exampleValue(object(sentFields(body)), {}),
            schema: object(body),
          },
        },
      }
    : undefined;
};

/**
 * The security an endpoint enforces: its page's `authMethod`, else the
 * site's `api.auth`, else none. An API key goes in the configured header,
 * `x-api-key` when none is named.
 */
export const endpointSecurity = (
  authMethod?: AuthMethod,
  siteAuth?: EndpointAuth
): OperationSecurity => {
  const method = authMethod ?? siteAuth?.method ?? "none";
  if (method === "none") {
    return { alternatives: [], optional: false };
  }
  if (method === "key") {
    return resolveSecurity([{ apiKey: [] }], {
      apiKey: {
        in: "header",
        name: siteAuth?.name ?? "x-api-key",
        type: "apiKey",
      },
    });
  }
  return resolveSecurity([{ [method]: [] }], {
    [method]: { scheme: method, type: "http" },
  });
};

/**
 * The endpoint spec the page's plugin wrote into the `spec` attribute of
 * `<ApiEndpoint>` and `<ApiPlayground>`.
 */
export const readEndpointSpec = (json: string): EndpointSpec =>
  // SAFETY: the attribute is `JSON.stringify` of an `EndpointSpec`, written
  // by `markdown/api-rail.ts` at build; authors never write it.
  JSON.parse(json) as EndpointSpec;
