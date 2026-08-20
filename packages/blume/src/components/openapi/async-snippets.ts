import type {
  AsyncApiAction,
  AsyncApiServerObject,
} from "../../openapi/asyncapi.ts";

/**
 * Protocol-aware code samples for AsyncAPI operations — the async counterpart
 * of `snippets.ts`. Samples are written from the reader's side of the wire:
 * a `receive` operation means the application receives, so the sample shows
 * how to *produce* a message; a `send` operation shows how to consume one.
 * Protocols without a supported tool yield no samples at all — the message
 * example panel already shows the payload, and fabricating a client for an
 * unknown binding would be worse than nothing.
 *
 * Dependency-free for the same reason `snippets.ts` is: the event composer
 * re-renders these samples live in the browser, so importing anything from
 * `helpers.ts` would drag openapi-sampler into that lazy chunk (~13 kB) to
 * pretty-print a payload.
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
const hostParts = (server?: AsyncApiServerObject) => {
  const raw = server?.host ?? "localhost";
  const colon = raw.lastIndexOf(":");
  if (colon > 0 && /^\d+$/u.test(raw.slice(colon + 1))) {
    return { host: raw.slice(0, colon), port: raw.slice(colon + 1) };
  }
  return { host: raw, port: undefined };
};

/** POSIX single-quote escaping, matching `snippets.ts`. */
const shellQuote = (text: string): string =>
  `'${text.replaceAll("'", String.raw`'\''`)}'`;

/**
 * Indented payload for a snippet that spans lines, matching `toJson`. Only an
 * absent payload (unparseable editor text) becomes `{}`; a payload of `null`
 * is what the reader typed and travels as written.
 */
const payloadJson = (sample: MessageSample): string =>
  JSON.stringify(sample.payload === undefined ? {} : sample.payload, null, 2);

/** Compact single-line payload for shell `-m`/`echo` arguments. */
const payloadInline = (sample: MessageSample): string =>
  JSON.stringify(sample.payload === undefined ? {} : sample.payload);

/**
 * `wss://host/path` for a WebSocket channel; the address is the path. Exported
 * because the live composer connects to exactly this URL — the samples and the
 * connection cannot point at different endpoints.
 */
export const webSocketUrl = (sample: MessageSample): string => {
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
  const connect = `wscat -c ${shellQuote(webSocketUrl(sample))}`;
  return sample.action === "receive"
    ? `${connect}\n> ${payloadInline(sample)}`
    : `# Prints each message as it arrives\n${connect}`;
};

const webSocketSnippet = (sample: MessageSample): string => {
  const open = `const socket = new WebSocket(${JSON.stringify(webSocketUrl(sample))});`;
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

const TOOLS = {
  js: { build: webSocketSnippet, id: "js", label: "JavaScript", lang: "js" },
  kcat: { build: kcatSnippet, id: "kcat", label: "kcat", lang: "bash" },
  mosquitto: {
    build: mosquittoSnippet,
    id: "mosquitto",
    label: "mosquitto",
    lang: "bash",
  },
  wscat: { build: wscatSnippet, id: "wscat", label: "wscat", lang: "bash" },
} satisfies Record<string, AsyncSampleLanguage>;

type ToolId = keyof typeof TOOLS;

/** The tools appropriate to each protocol binding, in display order. */
const PROTOCOL_TOOLS = new Map<string, readonly ToolId[]>([
  ["kafka", ["kcat"]],
  ["mqtt", ["mosquitto"]],
  ["ws", ["wscat", "js"]],
]);

/** Accepted spellings for configured `codeSamples` ids. */
const ALIASES = new Map<string, ToolId>([
  ["javascript", "js"],
  ["kafkacat", "kcat"],
  ["mosquitto_pub", "mosquitto"],
  ["mosquitto_sub", "mosquitto"],
  ["node", "js"],
  ["typescript", "js"],
  ["websocket", "js"],
]);

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
  const candidates = PROTOCOL_TOOLS.get(protocol ?? "") ?? [];
  if (candidates.length === 0) {
    return [];
  }
  if (ids.length === 0) {
    return candidates.map((id) => TOOLS[id]);
  }
  const chosen: AsyncSampleLanguage[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    // Case-insensitive like `sampleLanguages` — the docs spell the tools
    // `WebSocket`/`mosquitto_pub`, so configured ids arrive in any casing.
    const id = ALIASES.get(raw.toLowerCase()) ?? raw.toLowerCase();
    const match = candidates.find((candidate) => candidate === id);
    if (match && !seen.has(match)) {
      seen.add(match);
      chosen.push(TOOLS[match]);
    }
  }
  return chosen;
};
