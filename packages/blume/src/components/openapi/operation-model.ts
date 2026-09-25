import { withServerDefaults } from "../../openapi/model.ts";
import {
  declaredExample,
  exampleValue,
  objectProperties,
  resolveSchema,
  toJson,
} from "./helpers.ts";
import type {
  ComponentsLike,
  ParameterLike,
  SchemaLike,
  SpecValue,
} from "./helpers.ts";
import {
  declaredTypes,
  inputValue,
  scalarType,
  validationSchema,
} from "./playground-schema.ts";
import { bodyEncoding } from "./request.ts";
import type {
  ParamSerialization,
  PlaygroundAuthInput,
  PlaygroundBody,
  PlaygroundBodyField,
  PlaygroundModel,
  PlaygroundParam,
} from "./request.ts";
import { schemeLabel } from "./security.ts";
import type { OperationSecurity, ResolvedScheme } from "./security.ts";

/**
 * Server-side derivation of the playground's request model. This is where the
 * spec document, openapi-sampler, and the security resolution meet — once, at
 * build time. The resulting `PlaygroundModel` is embedded as JSON on the page,
 * so the client (`request.ts`) never needs any of those dependencies.
 */

interface MediaTypeLike {
  schema?: SchemaLike;
  example?: SpecValue;
  examples?: SpecValue;
  encoding?: SpecValue;
}

/** A server entry: its URL template and the variables that fill it. */
export interface ServerLike {
  url?: string;
  variables?: SpecValue;
}

/**
 * The servers an operation is sent to: its own `servers` when it declares
 * any, else its path item's, else the document's — each level overrides the
 * one above it, as the OpenAPI spec defines.
 */
export const effectiveServers = (
  operation: ServerLike[] | undefined,
  pathItem: ServerLike[] | undefined,
  document: ServerLike[] | undefined
): ServerLike[] =>
  [operation, pathItem, document].find(
    (servers) => Array.isArray(servers) && servers.length > 0
  ) ?? [];

/** Primitive types the flat-body fields UI can edit directly. */
const PRIMITIVE_TYPES = {
  boolean: true,
  integer: true,
  number: true,
  string: true,
} as const;

/** Whether a spec example is a plain object usable for per-field defaults. */
const isExampleObject = (
  value: SpecValue
): value is Record<string, SpecValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: SpecValue): value is string =>
  typeof value === "string";

const isBoolean = (value: SpecValue): value is boolean =>
  typeof value === "boolean";

/**
 * The `style`/`explode` a parameter or form-body encoding declares, kept only
 * when declared so the embedded model stays small; the request builder
 * applies the OpenAPI defaults for the rest.
 */
const serialization = (node: Record<string, SpecValue>): ParamSerialization => {
  const rule: ParamSerialization = {};
  if (isString(node.style)) {
    rule.style = node.style;
  }
  if (isBoolean(node.explode)) {
    rule.explode = node.explode;
  }
  return rule;
};

/** A form body's declared per-field `encoding`, when it names any style. */
const formEncoding = (
  encoding: SpecValue
): PlaygroundBody["encoding"] | undefined => {
  if (!isExampleObject(encoding)) {
    return undefined;
  }
  const fields: NonNullable<PlaygroundBody["encoding"]> = {};
  for (const [name, entry] of Object.entries(encoding)) {
    const rule = isExampleObject(entry) ? serialization(entry) : {};
    if (Object.keys(rule).length > 0) {
      fields[name] = rule;
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
};

/**
 * Playground inputs for the operation's parameters. Cookie params are skipped
 * (not supported in v1 — browsers won't let a page set arbitrary cookies).
 * Path params are always required per spec, even when a lax document omits the
 * flag. Only REQUIRED params get a precomputed example; optional ones default
 * to "" so the default samples carry required params only — parity with the
 * old static samples.
 */
const modelParams = (
  parameters: ParameterLike[],
  schemas: Record<string, SchemaLike>,
  components: ComponentsLike | undefined
): PlaygroundParam[] => {
  const params: PlaygroundParam[] = [];
  for (const param of parameters) {
    const where = param.in;
    if (
      !param.name ||
      (where !== "path" && where !== "query" && where !== "header")
    ) {
      continue;
    }
    const required = where === "path" ? true : param.required === true;
    const schema = resolveSchema(schemas, param.schema);
    params.push({
      description: param.description,
      enum: schema.enum?.map(String),
      in: where,
      name: param.name,
      required,
      type: scalarType(param.schema, schemas),
      value: required
        ? inputValue(
            declaredExample(param, components) ??
              exampleValue(param.schema, schemas)
          )
        : "",
      ...serialization(param),
    });
  }
  return params;
};

/** The JSON-ish media entry: first whose type mentions json, else the first. */
const jsonContentType = (
  content: Record<string, MediaTypeLike> | undefined
): [string, MediaTypeLike] | undefined => {
  const entries = Object.entries(content ?? {});
  return entries.find(([type]) => type.includes("json")) ?? entries[0];
};

/**
 * Typed field inputs when the body schema is a flat object of primitives —
 * anything nested (object/array properties) falls back to the raw JSON editor,
 * where structure is easier to edit than in exploded form fields.
 */
const bodyFields = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  example: SpecValue
): PlaygroundBodyField[] | undefined => {
  const resolved = resolveSchema(schemas, schema);
  if (declaredTypes(resolved.type).some((type) => type !== "object")) {
    return undefined;
  }
  const { properties, required } = objectProperties(resolved, schemas);
  if (properties.length === 0) {
    return undefined;
  }
  const defaults = isExampleObject(example) ? example : undefined;
  const fields: PlaygroundBodyField[] = [];
  for (const [name, property] of properties) {
    const propertySchema = resolveSchema(schemas, property);
    const type = scalarType(property, schemas);
    if (
      !(type in PRIMITIVE_TYPES) ||
      propertySchema.properties ||
      propertySchema.items
    ) {
      return undefined;
    }
    fields.push({
      description: propertySchema.description,
      enum: propertySchema.enum?.map(String),
      name,
      // A `readOnly` property's `required` binds responses only: a request
      // shouldn't send the server-generated field at all.
      required:
        required.has(name) &&
        property.readOnly !== true &&
        propertySchema.readOnly !== true,
      type,
      value: inputValue(defaults?.[name]),
    });
  }
  return fields;
};

/**
 * The playground's body editor state, when the operation takes a request body.
 * JSON, form-urlencoded, and multipart bodies are edited as JSON (typed fields
 * when flat) and serialized for their media type on send; any other media
 * type is raw text, prefilled with a string example as written.
 */
const modelBody = (
  requestBody: { content?: Record<string, MediaTypeLike> } | undefined,
  schemas: Record<string, SchemaLike>,
  components: ComponentsLike | undefined
): PlaygroundBody | undefined => {
  const media = jsonContentType(requestBody?.content);
  if (!media) {
    return undefined;
  }
  const [contentType, mediaType] = media;
  const exampleData =
    declaredExample(mediaType, components) ??
    exampleValue(mediaType.schema, schemas);
  const encoding = bodyEncoding(contentType);
  const raw = encoding === "raw";
  const body: PlaygroundBody = {
    contentType,
    example:
      raw && isString(exampleData) ? exampleData : (toJson(exampleData) ?? ""),
    fields: raw
      ? undefined
      : bodyFields(mediaType.schema, schemas, exampleData),
    schema: validationSchema(mediaType.schema, schemas),
  };
  const fieldEncoding =
    encoding === "form" ? formEncoding(mediaType.encoding) : undefined;
  if (fieldEncoding) {
    body.encoding = fieldEncoding;
  }
  return body;
};

const AUTHORIZATION_HEADER = { in: "header", name: "Authorization" } as const;

/**
 * One resolved security scheme -> the playground input that collects its
 * credential. Mutual TLS travels outside the request and an unknown ref can't
 * be guessed — both contribute nothing.
 */
const authInput = (
  resolved: ResolvedScheme
): PlaygroundAuthInput | undefined => {
  const { scheme } = resolved;
  const label = schemeLabel(resolved);
  switch (scheme?.type) {
    case "http": {
      const kind = (scheme.scheme ?? "bearer").toLowerCase();
      if (kind === "basic") {
        return {
          carrier: AUTHORIZATION_HEADER,
          id: resolved.key,
          kind: "basic",
          label,
          placeholder: "YOUR_CREDENTIALS",
          prefix: "Basic ",
        };
      }
      if (kind === "bearer") {
        return {
          carrier: AUTHORIZATION_HEADER,
          id: resolved.key,
          kind: "bearer",
          label,
          placeholder: "YOUR_TOKEN",
          prefix: "Bearer ",
        };
      }
      // Digest and friends: a paste field like bearer, scheme-name prefix.
      return {
        carrier: AUTHORIZATION_HEADER,
        id: resolved.key,
        kind: "bearer",
        label,
        placeholder: "YOUR_CREDENTIALS",
        prefix: `${kind.charAt(0).toUpperCase() + kind.slice(1)} `,
      };
    }
    case "oauth2":
    case "openIdConnect": {
      // Token paste, no flow — the playground doesn't run OAuth dances.
      return {
        carrier: AUTHORIZATION_HEADER,
        id: resolved.key,
        kind: "oauth2",
        label,
        placeholder: "YOUR_ACCESS_TOKEN",
        prefix: "Bearer ",
      };
    }
    case "apiKey": {
      const where = scheme.in;
      return {
        carrier: {
          in: where === "query" || where === "cookie" ? where : "header",
          name: scheme.name ?? resolved.key,
        },
        id: resolved.key,
        kind: "apiKey",
        label,
        placeholder: "YOUR_API_KEY",
        prefix: "",
      };
    }
    default: {
      return undefined;
    }
  }
};

/** Derive the playground request model for one operation, at build time. */
export const operationModel = (args: {
  method: string;
  path: string;
  /** Pre-merged/resolved (`mergeParameters` output). */
  parameters: ParameterLike[];
  requestBody?: { content?: Record<string, MediaTypeLike> };
  /** The operation's effective servers (`effectiveServers` output). */
  servers: ServerLike[];
  schemas: Record<string, SchemaLike>;
  /** The document's `components`, which `$ref`'d examples resolve against. */
  components?: ComponentsLike;
  security: OperationSecurity;
}): PlaygroundModel => ({
  // First alternative only — the spec's preferred way to authorize, matching
  // what the static samples always showed.
  auth: (args.security.alternatives[0] ?? []).flatMap((resolved) => {
    const input = authInput(resolved);
    return input ? [input] : [];
  }),
  authOptional: args.security.optional,
  body: modelBody(args.requestBody, args.schemas, args.components),
  method: args.method.toUpperCase(),
  params: modelParams(args.parameters, args.schemas, args.components),
  path: args.path,
  // Variables resolve to their defaults: the samples and Send need a real URL.
  servers: args.servers.map((server) =>
    withServerDefaults(server.url ?? "", server.variables)
  ),
});
