import type {
  AsyncApiChannelObject,
  AsyncApiDocument,
  AsyncApiOperationObject,
  AsyncApiRefLike,
  AsyncApiServerObject,
  AsyncApiSpecValue,
} from "../../openapi/asyncapi.ts";
import type { ParameterLike, SchemaLike } from "./helpers.ts";
import { resolveComponentRef } from "./helpers.ts";

/**
 * Runtime helpers for the AsyncAPI components — the async counterpart of
 * `helpers.ts`. These operate on the normalized 3.x document behind the
 * `blume:openapi` alias, resolving the ref shapes AsyncAPI adds on top of
 * `#/components/*`: operations point at channels, channel messages may `$ref`
 * `#/components/messages`, and operation messages point *into* a channel
 * (`#/channels/<id>/messages/<name>`). Browser-safe like the rest of the set.
 */

/** A permissive view of an AsyncAPI message — only the fields we render. */
export interface AsyncApiMessageLike extends AsyncApiRefLike {
  name?: string;
  title?: string;
  summary?: string;
  description?: string;
  contentType?: string;
  payload?: AsyncApiSpecValue;
  headers?: AsyncApiSpecValue;
  examples?: {
    name?: string;
    summary?: string;
    payload?: AsyncApiSpecValue;
    headers?: AsyncApiSpecValue;
  }[];
  bindings?: AsyncApiChannelObject["bindings"];
}

/** A message paired with its channel-map key (the fallback display name). */
export interface NamedMessage {
  key: string;
  message: AsyncApiMessageLike;
}

const isObject = (
  value: AsyncApiSpecValue
): value is Record<string, AsyncApiSpecValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Permissive spec nodes may lie about declared string fields; verify first. */
const isString = (value: AsyncApiSpecValue): value is string =>
  typeof value === "string";

/** Decode a JSON-pointer token: `user~1signedup` -> `user/signedup`. */
const unescapePointer = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

const CHANNEL_MESSAGE_REF =
  /^#\/channels\/(?<channel>.+)\/messages\/(?<name>[^/]+)$/u;

type Components = AsyncApiDocument["components"];

/** Resolve a channel-map message (possibly a components `$ref`) to its object. */
const channelMessage = (
  raw: AsyncApiRefLike | undefined,
  components: Components
): AsyncApiMessageLike | undefined => {
  if (!isObject(raw)) {
    return undefined;
  }
  const resolved = resolveComponentRef(raw, components, "messages");
  // Still a bare `$ref` after resolution means it pointed nowhere useful.
  if (isString(resolved.$ref)) {
    return undefined;
  }
  // SAFETY: `resolved` is a plain message object; the permissive message view
  // only narrows the fields the components render, all of them optional.
  return resolved as AsyncApiMessageLike;
};

/**
 * The messages one operation carries: its own `messages` refs when declared
 * (each pointing into the channel's message map or at a components message),
 * else every message the channel declares. Unresolvable refs are dropped —
 * the schema tables can only render an actual message object.
 */
export const operationMessages = (
  operation: AsyncApiOperationObject | undefined,
  channel: AsyncApiChannelObject | undefined,
  document: AsyncApiDocument
): NamedMessage[] => {
  const { components } = document;
  const messageMap: Record<string, AsyncApiRefLike> = isObject(
    channel?.messages
  )
    ? channel.messages
    : {};
  const refs = operation?.messages;
  if (!Array.isArray(refs) || refs.length === 0) {
    const all: NamedMessage[] = [];
    for (const [key, raw] of Object.entries(messageMap)) {
      const message = channelMessage(raw, components);
      if (message) {
        all.push({ key, message });
      }
    }
    return all;
  }
  const named: NamedMessage[] = [];
  for (const ref of refs) {
    if (!isObject(ref)) {
      continue;
    }
    const pointer = isString(ref.$ref)
      ? CHANNEL_MESSAGE_REF.exec(ref.$ref)?.groups?.name
      : undefined;
    const key = pointer === undefined ? undefined : unescapePointer(pointer);
    // A channel-message pointer resolves through the channel map; anything
    // else (a components ref, an inline message) resolves directly.
    const message =
      key === undefined
        ? channelMessage(ref, components)
        : channelMessage(messageMap[key], components);
    if (message) {
      named.push({ key: key ?? message.name ?? "message", message });
    }
  }
  return named;
};

/** A message's display name: its `name`/`title`, else its channel-map key. */
export const messageLabel = (named: NamedMessage): string =>
  named.message.title ?? named.message.name ?? named.key;

/**
 * The `schemaFormat` media types whose schemas render as JSON Schema: the
 * AsyncAPI Schema Object (a JSON Schema superset), OpenAPI Schema Objects,
 * and JSON Schema itself, in their bare and `+json`/`+yaml` spellings.
 */
const JSON_SCHEMA_FORMAT =
  /^application\/(?:vnd\.aai\.asyncapi|vnd\.oai\.openapi|schema)(?:\+(?:json|yaml))?$/u;

/**
 * The JSON-schema view of a possibly multi-format schema value
 * (`{ schemaFormat, schema }`, allowed on both message payloads and headers).
 * Unwraps when the format is JSON-schema compatible and yields nothing
 * otherwise (an Avro or Protobuf schema can't render as a schema table —
 * callers fall back to a note).
 */
export const schemaOf = (value: AsyncApiSpecValue): SchemaLike | undefined => {
  if (!isObject(value)) {
    return undefined;
  }
  if (isString(value.schemaFormat) && "schema" in value) {
    // Match the media type proper (parameters like `;version=…` stripped)
    // against the JSON-Schema-compatible formats AsyncAPI registers. A
    // substring test would misclassify e.g. Avro's `+json` encoding, whose
    // schema is JSON but not JSON Schema.
    const format = (value.schemaFormat.split(";")[0] ?? "")
      .trim()
      .toLowerCase();
    const jsonish = JSON_SCHEMA_FORMAT.test(format);
    if (jsonish && isObject(value.schema)) {
      // SAFETY: a JSON-Schema-format schema object; the permissive SchemaLike
      // view only narrows the fields the schema tables render, all optional.
      return value.schema as SchemaLike;
    }
    return undefined;
  }
  // SAFETY: a bare schema object; the permissive SchemaLike view only narrows
  // the fields the schema tables render, all of them optional.
  return value as SchemaLike;
};

/** The JSON-schema view of a message payload; see {@link schemaOf}. */
export const payloadSchema = (
  message: AsyncApiMessageLike
): SchemaLike | undefined => schemaOf(message.payload);

/** The channel-parameter fields {@link channelParameters} lowers. */
interface AsyncApiParameterLike extends AsyncApiRefLike {
  description?: string;
  default?: AsyncApiSpecValue;
  enum?: AsyncApiSpecValue[];
  examples?: AsyncApiSpecValue[];
}

/**
 * Channel parameters lowered into the shared parameter-table shape. AsyncAPI
 * 3.x parameters are always strings (`enum`/`default`/`examples`, no schema),
 * and every one is required — an address template can't resolve without it.
 */
export const channelParameters = (
  channel: AsyncApiChannelObject | undefined,
  document: AsyncApiDocument
): ParameterLike[] => {
  const parameters: ParameterLike[] = [];
  const declared: Record<string, AsyncApiRefLike> = channel?.parameters ?? {};
  for (const [name, raw] of Object.entries(declared)) {
    if (!isObject(raw)) {
      continue;
    }
    // SAFETY: the permissive parameter view only narrows the fields lowered
    // below; each one is runtime-checked before use.
    const parameter = resolveComponentRef(
      raw as AsyncApiParameterLike,
      document.components,
      "parameters"
    );
    const schema: SchemaLike = { type: "string" };
    if (Array.isArray(parameter.enum)) {
      schema.enum = parameter.enum;
    }
    if (parameter.default !== undefined) {
      schema.default = parameter.default;
    }
    const lowered: ParameterLike = {
      description: isString(parameter.description)
        ? parameter.description
        : undefined,
      in: "channel",
      name,
      required: true,
      schema,
    };
    // AsyncAPI parameters carry `examples` (an array of strings) rather than
    // OpenAPI's singular; the first usable one lowers into the shared slot so
    // the composer can prefill from it.
    const example = Array.isArray(parameter.examples)
      ? parameter.examples.find(isString)
      : undefined;
    if (example !== undefined) {
      lowered.example = example;
    }
    parameters.push(lowered);
  }
  return parameters;
};

const SERVER_REF = /^#\/servers\/(?<name>[^/]+)$/u;

/**
 * The servers a channel is available on: its `servers` refs when declared,
 * else every server the document declares (the spec's default).
 */
export const channelServers = (
  channel: AsyncApiChannelObject | undefined,
  document: AsyncApiDocument
): AsyncApiServerObject[] => {
  const all = document.servers ?? {};
  const refs = channel?.servers;
  if (!Array.isArray(refs) || refs.length === 0) {
    return Object.values(all).filter(isObject);
  }
  const servers: AsyncApiServerObject[] = [];
  for (const ref of refs) {
    const name = SERVER_REF.exec(
      isObject(ref) && isString(ref.$ref) ? ref.$ref : ""
    )?.groups?.name;
    const server = name === undefined ? undefined : all[unescapePointer(name)];
    if (isObject(server)) {
      servers.push(server);
    }
  }
  return servers;
};

/** Normalize protocol spellings onto the binding key they document. */
const PROTOCOL_ALIASES = {
  "kafka-secure": "kafka",
  mqtt5: "mqtt",
  mqtts: "mqtt",
  "secure-mqtt": "mqtt",
  wss: "ws",
};

/**
 * The protocol an operation speaks, for binding-aware code samples: the first
 * operation/channel binding key, else the first relevant server's `protocol`.
 */
export const protocolOf = (
  operation: AsyncApiOperationObject | undefined,
  channel: AsyncApiChannelObject | undefined,
  servers: AsyncApiServerObject[]
): string | undefined => {
  const declared =
    Object.keys(operation?.bindings ?? {})[0] ??
    Object.keys(channel?.bindings ?? {})[0] ??
    servers.find((server) => isString(server.protocol))?.protocol;
  if (!isString(declared) || declared === "") {
    return undefined;
  }
  const lower = declared.toLowerCase();
  // SAFETY: guarded by the `in` check, `lower` is one of the alias keys.
  return lower in PROTOCOL_ALIASES
    ? PROTOCOL_ALIASES[lower as keyof typeof PROTOCOL_ALIASES]
    : lower;
};

/**
 * The security list an operation actually enforces: its own `security` when
 * declared, else the union of its servers' — connecting already requires the
 * server's schemes. Server entries dedupe by `$ref`, so two servers sharing a
 * scheme render it once.
 */
export const asyncApiSecurityEntries = (
  operation: AsyncApiOperationObject | undefined,
  servers: AsyncApiServerObject[]
): AsyncApiRefLike[] => {
  if (Array.isArray(operation?.security)) {
    return operation.security;
  }
  const entries: AsyncApiRefLike[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    for (const entry of server.security ?? []) {
      if (!isObject(entry)) {
        continue;
      }
      if (isString(entry.$ref)) {
        if (seen.has(entry.$ref)) {
          continue;
        }
        seen.add(entry.$ref);
      }
      entries.push(entry);
    }
  }
  return entries;
};

/** One protocol's binding fields, ready for a key/value table. */
export interface BindingGroup {
  protocol: string;
  rows: { name: string; value: unknown }[];
}

/**
 * Binding maps flattened for display, `bindingVersion` (metadata, not
 * behavior) dropped. Values stay unformatted — the component renders schema-ish
 * objects as nested schema tables and everything else as code.
 */
export const bindingGroups = (
  bindings?: AsyncApiChannelObject["bindings"]
): BindingGroup[] => {
  const groups: BindingGroup[] = [];
  for (const [protocol, fields] of Object.entries(bindings ?? {})) {
    if (!isObject(fields)) {
      continue;
    }
    const rows = Object.entries(fields)
      .filter(([name]) => name !== "bindingVersion")
      .map(([name, value]) => ({ name, value }));
    if (rows.length > 0) {
      groups.push({ protocol, rows });
    }
  }
  return groups;
};
