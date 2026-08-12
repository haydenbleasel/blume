import {
  exampleValue,
  objectProperties,
  resolveSchema,
  toJson,
} from "./helpers.ts";
import type { ParameterLike, SchemaLike } from "./helpers.ts";
import type {
  PlaygroundAuthInput,
  PlaygroundBody,
  PlaygroundBodyField,
  PlaygroundModel,
  PlaygroundParam,
  ValidationSchema,
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
  example?: unknown;
}

/** Primitive types the flat-body fields UI can edit directly. */
const PRIMITIVE_TYPES: Record<string, true> = {
  boolean: true,
  integer: true,
  number: true,
  string: true,
};

/** A schema's declared non-null type names (3.1 arrays flattened). */
const declaredTypes = (type: string | string[] | undefined): string[] => {
  if (!type) {
    return [];
  }
  return (Array.isArray(type) ? type : [type]).filter(
    (entry) => entry !== "null"
  );
};

/** Short input-type label for a schema, resolved one `$ref` level: "string" default. */
const scalarType = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>
): string => declaredTypes(resolveSchema(schemas, schema).type)[0] ?? "string";

/**
 * Stringify a precomputed default for a form input. Empty string means "no
 * default"; non-string primitives round-trip through JSON so booleans and
 * numbers read back exactly.
 */
const inputValue = (value: unknown): string => {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
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
  schemas: Record<string, SchemaLike>
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
        ? inputValue(param.example ?? exampleValue(param.schema, schemas))
        : "",
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
  example: unknown
): PlaygroundBodyField[] | undefined => {
  const resolved = resolveSchema(schemas, schema);
  if (declaredTypes(resolved.type).some((type) => type !== "object")) {
    return undefined;
  }
  const { properties, required } = objectProperties(resolved, schemas);
  if (properties.length === 0) {
    return undefined;
  }
  const defaults =
    typeof example === "object" && example !== null && !Array.isArray(example)
      ? (example as Record<string, unknown>)
      : {};
  const fields: PlaygroundBodyField[] = [];
  for (const [name, property] of properties) {
    const propertySchema = resolveSchema(schemas, property);
    const type = scalarType(property, schemas);
    if (
      !PRIMITIVE_TYPES[type] ||
      propertySchema.properties ||
      propertySchema.items
    ) {
      return undefined;
    }
    fields.push({
      description: propertySchema.description,
      enum: propertySchema.enum?.map(String),
      name,
      required: required.has(name),
      type,
      value: inputValue(defaults[name]),
    });
  }
  return fields;
};

/** Recursion limit for pruned validation schemas — deep enough for real specs. */
const MAX_SCHEMA_DEPTH = 6;

/**
 * Prune a spec schema into the tiny subset `validate-json.ts` understands:
 * `$ref`s resolved inline, cycles cut (the visited set is copied per branch so
 * a ref reused by siblings still prunes fully), depth capped. Structure beyond
 * the cut simply goes unvalidated — advisory checks, not a gate.
 */
const pruneSchema = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  depth: number,
  seen: ReadonlySet<string>
): ValidationSchema | undefined => {
  if (!schema || depth >= MAX_SCHEMA_DEPTH) {
    return undefined;
  }
  let visited = seen;
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) {
      return undefined;
    }
    visited = new Set(seen).add(schema.$ref);
  }
  const resolved = resolveSchema(schemas, schema);
  const out: ValidationSchema = {};
  const [type] = declaredTypes(resolved.type);
  if (type) {
    out.type = type;
  }
  if (resolved.enum) {
    out.enum = resolved.enum;
  }
  if (resolved.required && resolved.required.length > 0) {
    out.required = resolved.required;
  }
  if (resolved.properties) {
    const properties: Record<string, ValidationSchema> = {};
    for (const [name, property] of Object.entries(resolved.properties)) {
      const pruned = pruneSchema(property, schemas, depth + 1, visited);
      if (pruned) {
        properties[name] = pruned;
      }
    }
    if (Object.keys(properties).length > 0) {
      out.properties = properties;
    }
  }
  if (resolved.items) {
    out.items = pruneSchema(resolved.items, schemas, depth + 1, visited);
  }
  return out;
};

/** The playground's body editor state, when the operation takes a request body. */
const modelBody = (
  requestBody: { content?: Record<string, MediaTypeLike> } | undefined,
  schemas: Record<string, SchemaLike>
): PlaygroundBody | undefined => {
  const media = jsonContentType(requestBody?.content);
  if (!media) {
    return undefined;
  }
  const [contentType, mediaType] = media;
  const exampleData =
    mediaType.example ?? exampleValue(mediaType.schema, schemas);
  return {
    contentType,
    example: toJson(exampleData) ?? "",
    fields: bodyFields(mediaType.schema, schemas, exampleData),
    schema: pruneSchema(mediaType.schema, schemas, 0, new Set()),
  };
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
  servers: { url?: string }[];
  schemas: Record<string, SchemaLike>;
  security: OperationSecurity;
}): PlaygroundModel => ({
  // First alternative only — the spec's preferred way to authorize, matching
  // what the static samples always showed.
  auth: (args.security.alternatives[0] ?? []).flatMap((resolved) => {
    const input = authInput(resolved);
    return input ? [input] : [];
  }),
  authOptional: args.security.optional,
  body: modelBody(args.requestBody, args.schemas),
  method: args.method.toUpperCase(),
  params: modelParams(args.parameters, args.schemas),
  path: args.path,
  servers: args.servers.map((server) => server.url ?? ""),
});
