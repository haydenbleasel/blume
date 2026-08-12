import type {
  AsyncApiChannelObject,
  AsyncApiDocument,
  AsyncApiOperationObject,
  AsyncApiRefLike,
  AsyncApiServerObject,
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
export interface AsyncApiMessageLike {
  name?: string;
  title?: string;
  summary?: string;
  description?: string;
  contentType?: string;
  payload?: SchemaLike;
  headers?: SchemaLike;
  examples?: {
    name?: string;
    summary?: string;
    payload?: unknown;
    headers?: unknown;
  }[];
  bindings?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** A message paired with its channel-map key (the fallback display name). */
export interface NamedMessage {
  key: string;
  message: AsyncApiMessageLike;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decode a JSON-pointer token: `user~1signedup` -> `user/signedup`. */
const unescapePointer = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

const CHANNEL_MESSAGE_REF =
  /^#\/channels\/(?<channel>.+)\/messages\/(?<name>[^/]+)$/u;

type Components = Record<string, Record<string, unknown>> | undefined;

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
  return typeof resolved.$ref === "string"
    ? undefined
    : (resolved as AsyncApiMessageLike);
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
  const messageMap = isObject(channel?.messages) ? channel.messages : {};
  const refs = operation?.messages;
  if (!Array.isArray(refs) || refs.length === 0) {
    const all: NamedMessage[] = [];
    for (const [key, raw] of Object.entries(messageMap)) {
      const message = channelMessage(raw as AsyncApiRefLike, components);
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
    const pointer =
      typeof ref.$ref === "string"
        ? CHANNEL_MESSAGE_REF.exec(ref.$ref)?.groups?.name
        : undefined;
    const key = pointer === undefined ? undefined : unescapePointer(pointer);
    // A channel-message pointer resolves through the channel map; anything
    // else (a components ref, an inline message) resolves directly.
    const message =
      key === undefined
        ? channelMessage(ref, components)
        : channelMessage(messageMap[key] as AsyncApiRefLike, components);
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
 * The JSON-schema view of a possibly multi-format schema value
 * (`{ schemaFormat, schema }`, allowed on both message payloads and headers).
 * Unwraps when the format is JSON-schema compatible and yields nothing
 * otherwise (an Avro or Protobuf schema can't render as a schema table —
 * callers fall back to a note).
 */
export const schemaOf = (value: unknown): SchemaLike | undefined => {
  if (!isObject(value)) {
    return undefined;
  }
  if (typeof value.schemaFormat === "string" && "schema" in value) {
    const format = value.schemaFormat;
    const jsonish =
      format.includes("json") ||
      format.includes("asyncapi") ||
      format.includes("openapi");
    return jsonish && isObject(value.schema)
      ? (value.schema as SchemaLike)
      : undefined;
  }
  return value as SchemaLike;
};

/** The JSON-schema view of a message payload; see {@link schemaOf}. */
export const payloadSchema = (
  message: AsyncApiMessageLike
): SchemaLike | undefined => schemaOf(message.payload);

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
  for (const [name, raw] of Object.entries(channel?.parameters ?? {})) {
    if (!isObject(raw)) {
      continue;
    }
    const parameter = resolveComponentRef(
      raw as AsyncApiRefLike,
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
    parameters.push({
      description:
        typeof parameter.description === "string"
          ? parameter.description
          : undefined,
      in: "channel",
      name,
      required: true,
      schema,
    });
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
      isObject(ref) && typeof ref.$ref === "string" ? ref.$ref : ""
    )?.groups?.name;
    const server = name === undefined ? undefined : all[unescapePointer(name)];
    if (isObject(server)) {
      servers.push(server);
    }
  }
  return servers;
};

/** Normalize protocol spellings onto the binding key they document. */
const PROTOCOL_ALIASES: Record<string, string> = {
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
    servers.find((server) => typeof server.protocol === "string")?.protocol;
  if (typeof declared !== "string" || declared === "") {
    return undefined;
  }
  const lower = declared.toLowerCase();
  return PROTOCOL_ALIASES[lower] ?? lower;
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
      if (typeof entry.$ref === "string") {
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
  bindings?: Record<string, Record<string, unknown>>
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
