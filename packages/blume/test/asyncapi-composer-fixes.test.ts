import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  bindingGroups,
  protocolOf,
  resolveBindings,
} from "../src/components/openapi/async.ts";
import { initComposer } from "../src/components/openapi/message-composer.ts";
import type { MessageModel } from "../src/components/openapi/message.ts";
import {
  buildMessage,
  defaultMessageValues,
} from "../src/components/openapi/message.ts";
import { createWsClient } from "../src/components/openapi/ws-client.ts";
import type { WsState } from "../src/components/openapi/ws-client.ts";
import { asElement, el, fire, installFakeDom, must } from "./fake-dom.ts";

/**
 * AsyncAPI operation fixes: bindings given as a `$ref`, channel parameters
 * written into non-URL addresses as they are, and a connect to a URL the
 * browser refuses outright.
 */

const COMPONENTS = {
  channelBindings: { kafkaChannel: { kafka: { topic: "sensors" } } },
  operationBindings: {
    // A `/` in the name is `~1` in the pointer.
    "ws/op": { ws: { bindingVersion: "0.1.0", method: "GET" } },
  },
};

describe("bindings given as a $ref", () => {
  it("resolves the ref instead of reading `$ref` as the protocol", () => {
    const operation = {
      bindings: { $ref: "#/components/operationBindings/ws~1op" },
    };
    expect(protocolOf(operation, {}, [], COMPONENTS)).toBe("ws");
    expect(
      protocolOf(
        {},
        { bindings: { $ref: "#/components/channelBindings/kafkaChannel" } },
        [],
        COMPONENTS
      )
    ).toBe("kafka");
    expect(bindingGroups(operation.bindings, COMPONENTS)).toStrictEqual([
      { protocol: "ws", rows: [{ name: "method", value: "GET" }] },
    ]);
  });

  it("falls back past a ref that resolves to nothing", () => {
    const servers = [{ protocol: "mqtt" }];
    for (const $ref of [
      "#/components/operationBindings/missing",
      "#/components/schemas/Other",
    ]) {
      expect(resolveBindings({ $ref }, COMPONENTS)).toBeUndefined();
      expect(protocolOf({ bindings: { $ref } }, {}, servers, COMPONENTS)).toBe(
        "mqtt"
      );
    }
    expect(resolveBindings({ $ref: "#/x" })).toBeUndefined();
    // An inline map passes through untouched.
    const inline = { ws: {} };
    expect(resolveBindings(inline, COMPONENTS)).toBe(inline);
    expect(resolveBindings(undefined, COMPONENTS)).toBeUndefined();
  });
});

const messageModel = (protocol: string | undefined): MessageModel => ({
  action: "send",
  address: "sensors/{sensorId}/readings",
  connectable: protocol === "ws",
  params: [{ name: "sensorId", value: "sensor 1/a" }],
  payload: { example: "" },
  protocol,
  servers: [],
});

describe("channel parameters in the address", () => {
  it("encodes a value only where the address is a URL", () => {
    const address = (protocol?: string) => {
      const model = messageModel(protocol);
      return buildMessage(model, defaultMessageValues(model)).address;
    };
    expect(address("ws")).toBe("sensors/sensor%201%2Fa/readings");
    expect(address("https")).toBe("sensors/sensor%201%2Fa/readings");
    expect(address("kafka")).toBe("sensors/sensor 1/a/readings");
    expect(address("mqtt")).toBe("sensors/sensor 1/a/readings");
    expect(address()).toBe("sensors/sensor 1/a/readings");
  });
});

/**
 * The browser's `WebSocket` constructor refusing a URL outright. A function
 * expression, not an arrow: the composer calls it with `new`.
 */
const RefusingWebSocket = function RefusingWebSocket(url: string): never {
  throw new SyntaxError(`The URL '${url}' is invalid.`);
};

describe("a URL the browser refuses to dial", () => {
  it("settles the client in error with the reason", () => {
    const states: [WsState, string | undefined][] = [];
    const client = createWsClient({
      create: (url) => {
        throw new SyntaxError(`The URL '${url}' is invalid.`);
      },
      onFrame: () => {},
      onState: (state, detail) => states.push([state, detail]),
    });
    client.connect("ws://bad host");
    expect(client.state()).toBe("error");
    // Nothing to close: disconnect stays a no-op, and connect can retry.
    client.disconnect();
    client.connect("ws://still bad");
    expect(states).toStrictEqual([
      ["connecting", undefined],
      ["error", "The URL 'ws://bad host' is invalid."],
      ["connecting", undefined],
      ["error", "The URL 'ws://still bad' is invalid."],
    ]);
  });

  describe("in the composer", () => {
    let restoreDom: () => void;
    let savedSocket: PropertyDescriptor | undefined;

    beforeAll(() => {
      restoreDom = installFakeDom();
      savedSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: RefusingWebSocket,
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

    it("shows the error and re-enables Connect instead of hanging", () => {
      const model: MessageModel = {
        ...messageModel("ws"),
        params: [],
        servers: [
          {
            label: "ws://bad host",
            server: { host: "bad host", protocol: "ws" },
          },
        ],
      };
      const root = el("blume-message-composer");
      root.append(
        el("script", { "data-composer-model": "" }, JSON.stringify(model))
      );
      const connect = el("button", { "data-connect": "" });
      const disconnect = el("button", { "data-disconnect": "" });
      const status = el("div", { "data-status": "" });
      root.append(connect, disconnect, status);
      initComposer(asElement(root));
      fire(connect, "click", null);
      expect(status.textContent).toStartWith("Couldn't connect: The URL");
      expect(status.className).toContain("text-red-600");
      expect(must(connect).disabled).toBe(false);
      expect(disconnect.disabled).toBe(true);
    });
  });
});
