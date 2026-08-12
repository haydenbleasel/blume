import type {
  AsyncApiAction,
  AsyncApiServerObject,
} from "../../openapi/asyncapi.ts";
import { toJson } from "./helpers.ts";

/**
 * Protocol-aware code samples for AsyncAPI operations — the async counterpart
 * of `snippets.ts`. Samples are written from the reader's side of the wire:
 * a `receive` operation means the application receives, so the sample shows
 * how to *produce* a message; a `send` operation shows how to consume one.
 * Protocols without a supported tool yield no samples at all — the message
 * example panel already shows the payload, and fabricating a client for an
 * unknown binding would be worse than nothing.
 */

/** Everything a snippet builder needs about one operation. */
export interface MessageSample {
  action: AsyncApiAction;
  /** Channel address, `{param}` templates left intact. */
  address: string;
  /** Example payload value (undefined when none could be derived). */
  payload?: unknown;
  /** First server the channel is available on, if any. */
  server?: AsyncApiServerObject;
}

/** `host[:port]` split apart; MQTT tooling wants them as separate flags. */
const hostParts = (
  server?: AsyncApiServerObject
): { host: string; port?: string } => {
  const raw = server?.host ?? "localhost";
  const colon = raw.lastIndexOf(":");
  if (colon > 0 && /^\d+$/u.test(raw.slice(colon + 1))) {
    return { host: raw.slice(0, colon), port: raw.slice(colon + 1) };
  }
  return { host: raw };
};

/** POSIX single-quote escaping, matching `snippets.ts`. */
const shellQuote = (text: string): string =>
  `'${text.replaceAll("'", String.raw`'\''`)}'`;

const payloadJson = (sample: MessageSample): string =>
  toJson(sample.payload ?? {});

/** Compact single-line payload for shell `-m`/`echo` arguments. */
const payloadInline = (sample: MessageSample): string =>
  JSON.stringify(sample.payload ?? {});

/** `wss://host/path` for a WebSocket channel; the address is the path. */
const wsUrl = (sample: MessageSample): string => {
  const { server } = sample;
  const scheme = server?.protocol === "ws" ? "ws" : "wss";
  const host = server?.host ?? "localhost";
  const base = `${server?.pathname ?? ""}/${sample.address}`.replaceAll(
    /\/+/gu,
    "/"
  );
  return `${scheme}://${host}${base === "/" ? "" : base}`;
};

const wscatSnippet = (sample: MessageSample): string => {
  const connect = `wscat -c ${shellQuote(wsUrl(sample))}`;
  return sample.action === "receive"
    ? `${connect}\n> ${payloadInline(sample)}`
    : `# Prints each message as it arrives\n${connect}`;
};

const webSocketSnippet = (sample: MessageSample): string => {
  const open = `const socket = new WebSocket(${JSON.stringify(wsUrl(sample))});`;
  if (sample.action === "receive") {
    return [
      open,
      "",
      'socket.addEventListener("open", () => {',
      `  socket.send(JSON.stringify(${payloadJson(sample).replaceAll("\n", "\n  ")}));`,
      "});",
    ].join("\n");
  }
  return [
    open,
    "",
    'socket.addEventListener("message", (event) => {',
    "  console.log(JSON.parse(event.data));",
    "});",
  ].join("\n");
};

const kcatSnippet = (sample: MessageSample): string => {
  const broker = sample.server?.host ?? "localhost:9092";
  const base = `kcat -b ${shellQuote(broker)} -t ${shellQuote(sample.address)}`;
  return sample.action === "receive"
    ? `echo ${shellQuote(payloadInline(sample))} | ${base} -P`
    : `${base} -C`;
};

const mosquittoSnippet = (sample: MessageSample): string => {
  const { host, port } = hostParts(sample.server);
  const target = `-h ${shellQuote(host)}${port ? ` -p ${port}` : ""} -t ${shellQuote(sample.address)}`;
  return sample.action === "receive"
    ? `mosquitto_pub ${target} -m ${shellQuote(payloadInline(sample))}`
    : `mosquitto_sub ${target} -v`;
};

/** One renderable sample tool: tab id/label, Shiki language, builder. */
export interface AsyncSampleLanguage {
  id: string;
  label: string;
  lang: string;
  build: (sample: MessageSample) => string;
}

const TOOLS: Record<string, AsyncSampleLanguage> = {
  js: { build: webSocketSnippet, id: "js", label: "JavaScript", lang: "js" },
  kcat: { build: kcatSnippet, id: "kcat", label: "kcat", lang: "bash" },
  mosquitto: {
    build: mosquittoSnippet,
    id: "mosquitto",
    label: "mosquitto",
    lang: "bash",
  },
  wscat: { build: wscatSnippet, id: "wscat", label: "wscat", lang: "bash" },
};

/** The tools appropriate to each protocol binding, in display order. */
const PROTOCOL_TOOLS: Record<string, string[]> = {
  kafka: ["kcat"],
  mqtt: ["mosquitto"],
  ws: ["wscat", "js"],
};

/** Accepted spellings for configured `codeSamples` ids. */
const ALIASES: Record<string, string> = {
  javascript: "js",
  kafkacat: "kcat",
  mosquitto_pub: "mosquitto",
  mosquitto_sub: "mosquitto",
  node: "js",
  typescript: "js",
  websocket: "js",
};

/**
 * The sample tools to render for an operation. The protocol picks the
 * candidate set; a non-empty `codeSamples` config filters and orders it
 * (unknown ids are dropped, aliases accepted). No protocol, an unsupported
 * one, or a filter that matches nothing yields no samples.
 */
export const asyncSampleLanguages = (
  ids: string[],
  protocol?: string
): AsyncSampleLanguage[] => {
  const candidates = PROTOCOL_TOOLS[protocol ?? ""] ?? [];
  if (candidates.length === 0) {
    return [];
  }
  if (ids.length === 0) {
    return candidates.map((id) => TOOLS[id] as AsyncSampleLanguage);
  }
  const chosen: AsyncSampleLanguage[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = ALIASES[raw] ?? raw;
    if (candidates.includes(id) && !seen.has(id)) {
      seen.add(id);
      chosen.push(TOOLS[id] as AsyncSampleLanguage);
    }
  }
  return chosen;
};
