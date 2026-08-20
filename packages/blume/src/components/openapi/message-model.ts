import type {
  AsyncApiAction,
  AsyncApiServerObject,
} from "../../openapi/asyncapi.ts";
import type { AsyncApiMessageLike, NamedMessage } from "./async.ts";
import { payloadSchema } from "./async.ts";
import { exampleValue, toJson } from "./helpers.ts";
import type { ParameterLike, SchemaLike } from "./helpers.ts";
import type {
  MessageModel,
  MessageParam,
  MessagePayload,
  MessageServerOption,
} from "./message.ts";
import { inputValue, validationSchema } from "./playground-schema.ts";

/**
 * Server-side derivation of the event composer's message model — the AsyncAPI
 * counterpart of `operation-model.ts`. The spec document, the sampler, and the
 * channel/server resolution meet here once at build time; the resulting
 * {@link MessageModel} is embedded as JSON on the operation page so the lazy
 * client chunk carries none of it.
 */

/** The protocols a docs page can actually open a live connection to. */
const LIVE_PROTOCOLS = { ws: true } satisfies Record<string, true>;

/**
 * Channel parameters as composer inputs. `channelParameters` has already
 * lowered AsyncAPI's string-only parameters (enum, default, examples) into the
 * shared parameter shape, so all that is left is picking a prefill: the
 * declared default, first example, or first enum member, else nothing. Never
 * the sampler — its `{type:"string"}` output is the literal word `string`,
 * which would replace every `{name}` template in the address samples with
 * junk like `user/string/signedup`.
 */
const messageParams = (parameters: ParameterLike[]): MessageParam[] =>
  parameters.map((parameter) => ({
    description: parameter.description,
    enum: parameter.schema?.enum?.map(String),
    name: parameter.name ?? "",
    value: inputValue(
      parameter.schema?.default ??
        parameter.example ??
        parameter.schema?.enum?.[0]
    ),
  }));

/**
 * The payload editor's state for the operation's first message. Multi-message
 * operations render every message's schema on the page, but the composer sends
 * one payload — the first is the one the samples already show.
 */
const messagePayload = (
  message: AsyncApiMessageLike | undefined,
  schemas: Record<string, SchemaLike>
): MessagePayload => {
  if (!message) {
    return { example: "" };
  }
  const schema = payloadSchema(message);
  // `undefined` means the message declares no example, `null` means it declares
  // an empty one — only the former falls back to a schema sample. The sampler's
  // own `null` is its no-schema/failure sentinel, not a value a reader typed:
  // it degrades to an empty editor (which samples and sends `{}`) rather than
  // prefilling the literal `null`.
  const declared = message.examples?.[0]?.payload;
  const example =
    declared === undefined ? exampleValue(schema, schemas) : declared;
  return {
    contentType: message.contentType,
    example:
      declared === undefined && example === null ? "" : (toJson(example) ?? ""),
    schema: validationSchema(schema, schemas),
  };
};

/**
 * A server's base URL for the picker. Falls back to the bare host when the
 * spec omits `protocol` — a label is a label, and the snippet builders read
 * the server object itself rather than this string.
 */
const serverOption = (server: AsyncApiServerObject): MessageServerOption => {
  const host = `${server.host ?? ""}${server.pathname ?? ""}`;
  return {
    label: server.protocol ? `${server.protocol}://${host}` : host,
    server,
  };
};

/** Derive the composer's message model for one event operation, at build time. */
export const messageModel = (args: {
  action: AsyncApiAction;
  address: string;
  messages: NamedMessage[];
  parameters: ParameterLike[];
  protocol?: string;
  schemas: Record<string, SchemaLike>;
  servers: AsyncApiServerObject[];
}): MessageModel => ({
  action: args.action,
  address: args.address,
  connectable: Object.hasOwn(LIVE_PROTOCOLS, args.protocol ?? ""),
  params: messageParams(args.parameters),
  payload: messagePayload(args.messages[0]?.message, args.schemas),
  protocol: args.protocol,
  servers: args.servers.map(serverOption),
});
