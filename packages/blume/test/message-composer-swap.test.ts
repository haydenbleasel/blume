import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { initComposer } from "../src/components/openapi/message-composer.ts";
import type { MessageModel } from "../src/components/openapi/message.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";
import {
  asElement,
  el,
  fire,
  fireDocument,
  installFakeDom,
  must,
} from "./fake-dom.ts";

/**
 * A ClientRouter navigation swaps the composer out of the document without
 * unloading the page, so the composer closes its live WebSocket on
 * `astro:before-swap` instead of leaving it open behind the next page.
 */

const sockets: FakeSocket[] = [];

class FakeSocket {
  closed = false;
  events: string[] = [];
  sent: string[] = [];

  constructor() {
    sockets.push(this);
  }

  addEventListener(type: string): void {
    this.events.push(type);
  }

  close(): void {
    this.closed = true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const MODEL: MessageModel = {
  action: "receive",
  address: "signups",
  connectable: true,
  params: [],
  payload: { example: "{}" },
  protocol: "ws",
  servers: [
    {
      label: "wss://events.test",
      server: { host: "events.test", protocol: "wss" },
    },
  ],
};

let restoreDom: () => void;
let savedSocket: PropertyDescriptor | undefined;

beforeAll(() => {
  restoreDom = installFakeDom();
  savedSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
});

afterAll(() => {
  restoreDom();
  if (savedSocket) {
    Object.defineProperty(globalThis, "WebSocket", savedSocket);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

describe("composer navigation", () => {
  it("closes the live socket when the router swaps the page", () => {
    const root = el("blume-message-composer");
    const connect = el("button", { "data-connect": "" });
    const payload = el("textarea", { "data-payload": "" });
    payload.value = "{}";
    root.append(
      el("script", { "data-composer-model": "" }, JSON.stringify(MODEL)),
      el(
        "script",
        { "data-composer-strings": "", type: "application/json" },
        JSON.stringify(EN_UI.reference)
      ),
      payload,
      el("div", { "data-payload-errors": "" }),
      connect
    );
    initComposer(asElement(root));

    fire(connect, "click", null);
    const socket = must(sockets[0]);
    expect(socket.closed).toBe(false);

    fireDocument("astro:before-swap");
    expect(socket.closed).toBe(true);
    // One swap retires the panel for good; its listener doesn't linger.
    expect(() => fireDocument("astro:before-swap")).not.toThrow();
  });
});
