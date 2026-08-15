import type {
  AsyncApiAction,
  AsyncApiServerObject,
} from "../../openapi/asyncapi.ts";
import type { MessageSample } from "./async-snippets.ts";
import type { ValidationSchema } from "./request.ts";

/**
 * Framework-free message model for the event ("Try it") composer — the
 * AsyncAPI counterpart of `request.ts`. The composer form, the protocol-aware
 * code samples, and the live WebSocket frame all derive from one
 * {@link buildMessage} call, so a copied `wscat` command and a composed send
 * carry the same address and the same payload bytes by construction.
 *
 * Ships to the browser inside the composer's lazy chunk: no spec parser, no
 * sampler, no Astro imports.
 */

/** One channel parameter as a composer input. Channel params are always required. */
export interface MessageParam {
  description?: string;
  /** Declared `enum` members, when the parameter constrains its values. */
  enum?: string[];
  name: string;
  /** Prefill from the parameter's `default`/`examples`; "" when none. */
  value: string;
}

/** The composer's payload editor state. */
export interface MessagePayload {
  /** The message's declared `contentType`, when it has one. */
  contentType?: string;
  /** Pretty-printed prefill: declared example, else a schema sample; "" when none. */
  example: string;
  /** Pruned payload schema the editor validates against, when derivable. */
  schema?: ValidationSchema;
}

/** One server option in the picker: a display URL plus the spec object behind it. */
export interface MessageServerOption {
  /** `protocol://host+pathname` — what the reader picks between. */
  label: string;
  /** The spec server, verbatim; the snippet builders read host/pathname/protocol. */
  server: AsyncApiServerObject;
}

export interface MessageModel {
  action: AsyncApiAction;
  /** Channel address with `{param}` templates intact, e.g. `user/{id}/signedup`. */
  address: string;
  /**
   * Whether the panel offers a live connection. Only WebSocket bindings can be
   * driven from a docs page — Kafka, MQTT and friends get the composer and the
   * CLI samples rather than faked connectivity.
   */
  connectable: boolean;
  params: MessageParam[];
  payload: MessagePayload;
  /** Normalized binding key (`ws`, `kafka`, `mqtt`, …) when the spec implies one. */
  protocol?: string;
  servers: MessageServerOption[];
}

export interface MessageValues {
  /** Free-text server URL; overrides the picked server when non-empty. */
  customUrl: string;
  /** Key: parameter name. */
  params: Record<string, string>;
  /** Raw payload editor text. */
  payload: string;
  /** Index into `model.servers`; out of range falls back to the first. */
  server: number;
}

/** Values pre-filled from the model's precomputed examples. */
export const defaultMessageValues = (model: MessageModel): MessageValues => ({
  customUrl: "",
  params: Object.fromEntries(
    model.params.map((param) => [param.name, param.value])
  ),
  payload: model.payload.example,
  server: 0,
});

const PARAM_TEMPLATE = /\{(?<name>[^{}]+)\}/gu;

/**
 * A free-text base URL lowered onto the server shape the snippet builders and
 * the connect URL read. A full URL contributes its scheme, host, and path.
 * Anything without an authority — a bare `host:port`, which is how broker
 * tooling is usually addressed, and which `new URL` happily reads as a scheme
 * plus path — is kept whole as the host, leaving the protocol to the spec.
 */
const customServer = (url: string): AsyncApiServerObject => {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed || parsed.host === "") {
    return { host: url };
  }
  return {
    host: parsed.host,
    pathname: parsed.pathname === "/" ? "" : parsed.pathname,
    protocol: parsed.protocol.replace(":", ""),
  };
};

/**
 * THE one message builder: the composer's samples, its copy buttons, and the
 * live WebSocket frame all consume its output. Parameter values are
 * URL-encoded into the address; a parameter left blank keeps its `{name}`
 * template so the sample still reads as a template rather than a broken
 * address. Payload text that doesn't parse yields no payload — the editor is
 * showing the reader a validation error at that moment, and neither a sample
 * nor a send should invent a value.
 */
export const buildMessage = (
  model: MessageModel,
  values: MessageValues
): MessageSample => {
  const custom = values.customUrl.trim();
  const picked = model.servers[values.server] ?? model.servers[0];
  let payload: unknown;
  try {
    payload = JSON.parse(values.payload) as unknown;
  } catch {
    payload = undefined;
  }
  return {
    action: model.action,
    address: model.address.replaceAll(PARAM_TEMPLATE, (template, name) => {
      const value = values.params[String(name)] ?? "";
      return value === "" ? template : encodeURIComponent(value);
    }),
    payload,
    server: custom === "" ? picked?.server : customServer(custom),
  };
};

/**
 * The exact bytes a live send transmits. Identical to the payload the `wscat`
 * and browser-`WebSocket` samples embed, which is the whole point: what a
 * reader copies is what Send puts on the wire.
 */
export const messageFrame = (sample: MessageSample): string =>
  JSON.stringify(sample.payload ?? {});
