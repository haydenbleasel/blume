import {
  exampleValue,
  objectProperties,
  resolveSchema,
  toJson,
} from "./helpers.ts";
import type { ParameterLike, SchemaLike, SpecValue } from "./helpers.ts";
import {
  declaredTypes,
  inputValue,
  scalarType,
  validationSchema,
} from "./playground-schema.ts";
import type {
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
  example?: unknown;
}

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
      required: required.has(name),
      type,
      value: inputValue(defaults?.[name]),
    });
  }
  return fields;
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
  // SAFETY: `example` comes from the parsed spec document (YAML/JSON), whose
  // values are exactly the JSON-shaped tree `SpecValue` models.
  const exampleData =
    (mediaType.example as SpecValue) ?? exampleValue(mediaType.schema, schemas);
  return {
    contentType,
    example: toJson(exampleData) ?? "",
    fields: bodyFields(mediaType.schema, schemas, exampleData),
    schema: validationSchema(mediaType.schema, schemas),
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
