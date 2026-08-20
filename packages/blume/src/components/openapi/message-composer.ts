/**
 * Client logic for the event "Try it" composer, loaded lazily on the first open
 * of the `<details data-composer>` disclosure (see MessageComposer.astro — the
 * custom-element loader lives there so this module stays import-safe in
 * tests). One message model drives everything: the same {@link buildMessage}
 * output feeds the protocol-aware samples, the connect URL, and the frame that
 * goes on the wire, so what a reader copies is what the panel sends.
 *
 * Frames are rendered through `textContent` — a broker echoing HTML back must
 * never execute in the docs page.
 */

import { asyncSampleLanguages, webSocketUrl } from "./async-snippets.ts";
import type { MessageModel, MessageValues } from "./message.ts";
import { buildMessage, messageFrame } from "./message.ts";
import { validateJson } from "./validate-json.ts";
import type { WsFrame, WsState } from "./ws-client.ts";
import { createWsClient } from "./ws-client.ts";

/** Convention used across the OpenAPI components for error-severity text. */
const ERROR_TEXT = "text-red-600 text-xs dark:text-red-400";

/** The status line's normal (non-error) styling. */
const MUTED_TEXT = "text-muted-foreground text-xs";

/**
 * A failed WebSocket handshake gives the page no reason — the browser withholds
 * it — so the status line explains the causes a docs author can act on instead
 * of showing a bare "error".
 */
const ERROR_MESSAGE =
  "The connection failed. The broker may reject requests from this origin, " +
  "require credentials the URL doesn't carry, or be unreachable from here.";

/** Wall-clock prefix for a logged frame, e.g. `14:03:11`. */
const stamp = (at: number): string => new Date(at).toLocaleTimeString();

/**
 * Wire the composer inside `root` (the `<blume-message-composer>` element).
 * Keeps the samples in sync with the form, validates the payload, and — for
 * WebSocket bindings only — drives a live connection.
 */
export const initComposer = (root: HTMLElement): void => {
  const modelScript = root.querySelector("script[data-composer-model]");
  if (!modelScript) {
    return;
  }
  // SAFETY: this script tag is written only by MessageComposer.astro, which
  // serializes a typed MessageModel into it at build time — the JSON here can
  // hold nothing else.
  const model = JSON.parse(modelScript.textContent ?? "") as MessageModel;

  // The sample panes live in the sibling rail, so they are looked up from the
  // shared operation-panel wrapper rather than this element.
  const scope = root.closest("[data-operation-panel]") ?? document;
  const panes = [...scope.querySelectorAll<HTMLElement>("[data-sample-lang]")];
  const languages = new Map(
    asyncSampleLanguages(
      panes.map((pane) => pane.dataset.sampleLang ?? ""),
      model.protocol
    ).map((language) => [language.id, language])
  );

  const serverSelect = root.querySelector<HTMLSelectElement>("[data-server]");
  const serverCustom = root.querySelector<HTMLInputElement>(
    "[data-server-custom]"
  );
  const paramInputs = [
    ...root.querySelectorAll<HTMLInputElement>("[data-param]"),
  ];
  const payloadArea = root.querySelector<HTMLTextAreaElement>("[data-payload]");
  const payloadErrors = root.querySelector<HTMLElement>(
    "[data-payload-errors]"
  );
  const connectButton = root.querySelector<HTMLButtonElement>("[data-connect]");
  const disconnectButton =
    root.querySelector<HTMLButtonElement>("[data-disconnect]");
  const sendButton = root.querySelector<HTMLButtonElement>("[data-send]");
  const status = root.querySelector<HTMLElement>("[data-status]");
  const log = root.querySelector<HTMLElement>("[data-log]");

  /** The current form state as the shared MessageValues shape. */
  const collect = (): MessageValues => {
    const params: Record<string, string> = {};
    for (const input of paramInputs) {
      params[input.dataset.param ?? ""] = input.value;
    }
    return {
      customUrl: serverCustom?.value ?? "",
      params,
      payload: payloadArea?.value ?? model.payload.example,
      server: Number(serverSelect?.value ?? "0"),
    };
  };

  /** Re-render every sample pane from the live form. */
  const syncSamples = (): void => {
    const sample = buildMessage(model, collect());
    for (const pane of panes) {
      const language = languages.get(pane.dataset.sampleLang ?? "");
      if (!language) {
        continue;
      }
      const target = pane.querySelector("code") ?? pane;
      target.textContent = language.build(sample);
    }
  };

  /** Validate the payload editor and list the messages; [] when there is none. */
  const validatePayload = (): string[] => {
    if (!(payloadArea && payloadErrors)) {
      return [];
    }
    // An empty editor means "no payload" — `buildMessage` derives none and the
    // frame degrades to `{}` — not invalid JSON. Reporting a syntax error there
    // would permanently block Connect on an operation with no message example.
    const errors =
      payloadArea.value.trim() === ""
        ? []
        : validateJson(payloadArea.value, model.payload.schema, "payload");
    payloadErrors.textContent = "";
    for (const error of errors) {
      const item = document.createElement("span");
      item.className = ERROR_TEXT;
      item.textContent = error;
      payloadErrors.append(item);
    }
    return errors;
  };

  /**
   * The URL the live socket was dialed with; "" when nothing is connected. The
   * status line and the send path read this rather than recomputing from the
   * form, because the form can move on while a socket stays where it was.
   */
  let connectedUrl = "";

  /** The connect URL the form currently describes. */
  const formUrl = (): string => webSocketUrl(buildMessage(model, collect()));

  /** Write one message onto the status line, if the panel rendered one. */
  const setStatus = (text: string, className: string): void => {
    if (!status) {
      return;
    }
    status.textContent = text;
    status.className = className;
  };

  /** Reflect the connection state onto the status line and the buttons. */
  const renderState = (state: WsState, detail?: string): void => {
    const live = state === "connecting" || state === "open";
    if (!live) {
      connectedUrl = "";
    }
    if (connectButton) {
      connectButton.disabled = live;
    }
    if (disconnectButton) {
      disconnectButton.disabled = !live;
    }
    if (sendButton) {
      sendButton.disabled = state !== "open";
    }
    if (state === "connecting") {
      setStatus("Connecting\u2026", MUTED_TEXT);
      return;
    }
    if (state === "open") {
      setStatus(`Connected to ${connectedUrl}.`, MUTED_TEXT);
      return;
    }
    if (state === "error") {
      setStatus(ERROR_MESSAGE, ERROR_TEXT);
      return;
    }
    setStatus(
      detail ? `Disconnected (${detail}).` : "Not connected.",
      MUTED_TEXT
    );
  };

  /** Append one frame to the log: timestamp, direction, and the raw text. */
  const renderFrame = (frame: WsFrame): void => {
    if (!log) {
      return;
    }
    const row = document.createElement("div");
    row.className = "flex gap-2 font-mono text-xs";
    const meta = document.createElement("span");
    meta.className = "shrink-0 text-muted-foreground";
    meta.textContent = `${stamp(frame.at)} ${frame.direction === "sent" ? "\u2191" : "\u2193"}`;
    const text = document.createElement("span");
    text.className = "break-all text-foreground";
    text.textContent = frame.text;
    row.append(meta, text);
    log.append(row);
  };

  const client = createWsClient({ onFrame: renderFrame, onState: renderState });

  connectButton?.addEventListener("click", () => {
    if (validatePayload().length > 0) {
      return;
    }
    // A blank channel parameter leaves its `{name}` template in the address, so
    // connecting would dial a URL no broker has a channel for.
    const missing = paramInputs
      .filter((input) => input.value === "")
      .map((input) => input.dataset.param ?? "");
    if (missing.length > 0) {
      setStatus(
        `Fill in every channel parameter before connecting: ${missing.join(", ")}.`,
        ERROR_TEXT
      );
      return;
    }
    connectedUrl = formUrl();
    client.connect(connectedUrl);
  });
  disconnectButton?.addEventListener("click", () => client.disconnect());
  sendButton?.addEventListener("click", () => {
    if (validatePayload().length > 0) {
      return;
    }
    client.send(messageFrame(buildMessage(model, collect())));
  });

  const onEdit = (): void => {
    // The socket is bound to the URL it was dialed with: once the server or a
    // channel parameter moves, the open connection is the wrong endpoint, so it
    // is dropped rather than left to answer for the form on screen.
    if (connectedUrl !== "" && formUrl() !== connectedUrl) {
      client.disconnect();
      setStatus("The endpoint changed. Connect again to use it.", MUTED_TEXT);
    }
    validatePayload();
    syncSamples();
  };
  root.addEventListener("input", onEdit);
  root.addEventListener("change", onEdit);
};
