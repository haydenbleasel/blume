import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { initComposer } from "../src/components/openapi/message-composer.ts";
import type { MessageModel } from "../src/components/openapi/message.ts";
import type { SocketEvent } from "../src/components/openapi/ws-client.ts";
import type { FakeEl } from "./fake-dom.ts";
import { el, fire, installFakeDom, must } from "./fake-dom.ts";

/**
 * Tests for the lazily loaded event composer
 * (`src/components/openapi/message-composer.ts`), driven against the shared
 * fake DOM. Its collaborators (message.ts, async-snippets.ts,
 * validate-json.ts, ws-client.ts) are real; only the socket and the clock are
 * stubbed, so these exercise the integrated pipeline the browser runs.
 */

/** Every socket the composer opened during a test, in order. */
const sockets: FakeSocket[] = [];
let restoreDom: () => void;
let savedSocket: PropertyDescriptor | undefined;

/**
 * The socket the suite drives by hand, installed as the global `WebSocket` so
 * the composer's real `createWsClient` default factory picks it up — the
 * composer has no injection seam of its own, and shouldn't grow one for tests.
 */
class FakeSocket {
  closed = false;
  listeners = new Map<string, ((event: SocketEvent) => void)[]>();
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  /** Dispatch one socket event, as the browser would. */
  emit(type: string, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const MODEL: MessageModel = {
  action: "receive",
  address: "tenants/{tenant}/signedup",
  connectable: true,
  params: [{ name: "tenant", value: "acme" }],
  payload: {
    contentType: "application/json",
    example: '{\n  "id": "1"\n}',
    schema: {
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    },
  },
  protocol: "ws",
  servers: [
    { label: "wss://one.test", server: { host: "one.test", protocol: "wss" } },
    { label: "ws://two.test", server: { host: "two.test", protocol: "ws" } },
  ],
};

interface Fixture {
  errors: FakeEl;
  log: FakeEl;
  panes: FakeEl[];
  root: FakeEl;
  status: FakeEl;
}

/**
 * The composer markup the island server-renders, reduced to the hooks the
 * client reads. `omit` drops one hook so the client's absent-element branches
 * can be exercised the way a non-connectable or payload-less panel renders.
 */
const createFixture = (
  model: MessageModel = MODEL,
  omit: { log?: boolean; panel?: boolean; status?: boolean } = {}
): Fixture => {
  const root = el("blume-message-composer");
  root.append(
    el("script", { "data-composer-model": "" }, JSON.stringify(model))
  );
  const select = el("select", { "data-server": "" });
  select.value = "0";
  root.append(select, el("input", { "data-server-custom": "" }));
  for (const param of model.params) {
    const input = el("input", { "data-param": param.name });
    input.value = param.value;
    root.append(input);
  }
  const payload = el("textarea", { "data-payload": "" });
  payload.value = model.payload.example;
  const errors = el("div", { "data-payload-errors": "" });
  root.append(payload, errors);
  root.append(
    el("button", { "data-connect": "" }),
    el("button", { "data-disconnect": "" }),
    el("button", { "data-send": "" })
  );
  const status = el("div", { "data-status": "" });
  const log = el("div", { "data-log": "" });
  if (!omit.status) {
    root.append(status);
  }
  if (!omit.log) {
    root.append(log);
  }
  const wscat = el("div", { "data-sample-lang": "wscat" });
  wscat.append(el("code"));
  const unknown = el("div", { "data-sample-lang": "nope" });
  const panes = [wscat, unknown];
  if (omit.panel) {
    return { errors, log, panes, root, status };
  }
  const panel = el("div", { "data-operation-panel": "" });
  panel.append(root, wscat, unknown);
  return { errors, log, panes, root, status };
};

const field = (fixture: Fixture, selector: string): FakeEl =>
  must(fixture.root.querySelector(selector));

/** Type into a field and dispatch the `input` the client listens for. */
const type = (fixture: Fixture, selector: string, value: string): void => {
  const input = field(fixture, selector);
  input.value = value;
  fire(fixture.root, "input", input);
};

const click = (fixture: Fixture, selector: string): void => {
  fire(field(fixture, selector), "click", null);
};

beforeAll(() => {
  restoreDom = installFakeDom();
  savedSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
});

afterEach(() => {
  sockets.length = 0;
});

afterAll(() => {
  restoreDom();
  if (savedSocket) {
    Object.defineProperty(globalThis, "WebSocket", savedSocket);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

describe("initComposer", () => {
  it("does nothing without an embedded model", () => {
    const root = el("blume-message-composer");
    expect(() => initComposer(root as unknown as HTMLElement)).not.toThrow();
  });

  it("server-renders nothing and syncs samples from the live form", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    type(fixture, "[data-payload]", '{"id":"2"}');
    const [wscat, unknown] = fixture.panes;
    expect(must(wscat).textContent).toBe(
      'wscat -c \'wss://one.test/tenants/acme/signedup\'\n> {"id":"2"}'
    );
    // A pane whose language the protocol doesn't offer is left untouched.
    expect(must(unknown).textContent).toBe("");
  });

  it("follows the server picker and the custom URL override", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    type(fixture, "[data-server]", "1");
    expect(must(fixture.panes[0]).textContent).toContain("ws://two.test/");
    type(fixture, "[data-server-custom]", "wss://custom.test/socket");
    expect(must(fixture.panes[0]).textContent).toContain(
      "wss://custom.test/socket/tenants/acme/signedup"
    );
  });

  it("falls back to the document when there is no operation-panel wrapper", () => {
    const fixture = createFixture(MODEL, { panel: true });
    initComposer(fixture.root as unknown as HTMLElement);
    // No panes are found, so a sync is a no-op rather than a crash.
    type(fixture, "[data-payload]", '{"id":"3"}');
    expect(must(fixture.panes[0]).textContent).toBe("");
  });

  it("reports payload schema violations and refuses to connect", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    type(fixture, "[data-payload]", "{}");
    expect(fixture.errors.textContent).toBe("payload.id is required");
    click(fixture, "[data-connect]");
    expect(sockets).toHaveLength(0);
  });

  it("connects, logs both directions, and disconnects", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    click(fixture, "[data-connect]");
    expect(fixture.status.textContent).toBe("Connecting\u2026");
    expect(field(fixture, "[data-connect]").disabled).toBeTrue();
    const socket = must(sockets[0]);
    expect(socket.url).toBe("wss://one.test/tenants/acme/signedup");
    socket.emit("open");
    expect(fixture.status.textContent).toBe(
      "Connected to wss://one.test/tenants/acme/signedup."
    );
    expect(field(fixture, "[data-send]").disabled).toBeFalse();
    click(fixture, "[data-send]");
    expect(socket.sent).toStrictEqual(['{"id":"1"}']);
    socket.emit("message", { data: '{"ack":true}' });
    expect(fixture.log.textContent).toContain('\u2191{"id":"1"}');
    expect(fixture.log.textContent).toContain('\u2193{"ack":true}');
    click(fixture, "[data-disconnect]");
    expect(socket.closed).toBeTrue();
    expect(fixture.status.textContent).toBe("Not connected.");
  });

  it("refuses to send a payload that no longer validates", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    click(fixture, "[data-connect]");
    must(sockets[0]).emit("open");
    type(fixture, "[data-payload]", "{oops");
    click(fixture, "[data-send]");
    expect(must(sockets[0]).sent).toStrictEqual([]);
  });

  it("explains a failed handshake instead of showing a bare error", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    click(fixture, "[data-connect]");
    must(sockets[0]).emit("error");
    expect(fixture.status.textContent).toContain("The connection failed.");
    expect(fixture.status.className).toContain("text-red-600");
  });

  it("names the close reason when the broker gives one", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    click(fixture, "[data-connect]");
    must(sockets[0]).emit("open");
    must(sockets[0]).emit("close", { code: 1006, reason: "abnormal" });
    expect(fixture.status.textContent).toBe("Disconnected (1006 abnormal).");
  });

  it("survives a panel rendered without a status line or log", () => {
    const fixture = createFixture(MODEL, { log: true, status: true });
    initComposer(fixture.root as unknown as HTMLElement);
    click(fixture, "[data-connect]");
    must(sockets[0]).emit("open");
    click(fixture, "[data-send]");
    must(sockets[0]).emit("message", { data: "pong" });
    expect(must(sockets[0]).sent).toStrictEqual(['{"id":"1"}']);
    expect(fixture.log.textContent).toBe("");
    expect(fixture.status.textContent).toBe("");
  });

  it("skips validation entirely when the panel has no payload editor", () => {
    const model: MessageModel = {
      ...MODEL,
      params: [],
      payload: { example: "" },
    };
    const fixture = createFixture(model);
    must(fixture.root.querySelector("[data-payload]")).remove();
    initComposer(fixture.root as unknown as HTMLElement);
    click(fixture, "[data-connect]");
    must(sockets[0]).emit("open");
    click(fixture, "[data-send]");
    expect(must(sockets[0]).sent).toStrictEqual(["{}"]);
  });

  it("drops a connection whose endpoint the form moved away from", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    click(fixture, "[data-connect]");
    must(sockets[0]).emit("open");

    // The socket is still on one.test; the form now describes two.test, so the
    // live connection can no longer answer for what the panel shows.
    type(fixture, "[data-server]", "1");
    expect(must(sockets[0]).closed).toBeTrue();
    expect(fixture.status.textContent).toBe(
      "The endpoint changed. Connect again to use it."
    );
    expect(field(fixture, "[data-send]").disabled).toBeTrue();
    expect(field(fixture, "[data-connect]").disabled).toBeFalse();

    click(fixture, "[data-connect]");
    expect(must(sockets[1]).url).toBe("ws://two.test/tenants/acme/signedup");
    must(sockets[1]).emit("open");
    expect(fixture.status.textContent).toBe(
      "Connected to ws://two.test/tenants/acme/signedup."
    );

    // A channel parameter is the same story: the address it resolved is baked
    // into the open socket.
    type(fixture, '[data-param="tenant"]', "beta");
    expect(must(sockets[1]).closed).toBeTrue();
    expect(sockets).toHaveLength(2);
  });

  it("refuses to connect while a channel parameter is blank", () => {
    const fixture = createFixture();
    initComposer(fixture.root as unknown as HTMLElement);
    type(fixture, '[data-param="tenant"]', "");
    click(fixture, "[data-connect]");
    // Connecting would dial `…/tenants/{tenant}/signedup`, a channel no broker
    // has.
    expect(sockets).toHaveLength(0);
    expect(fixture.status.textContent).toBe(
      "Fill in every channel parameter before connecting: tenant."
    );
    expect(fixture.status.className).toContain("text-red-600");

    type(fixture, '[data-param="tenant"]', "beta");
    click(fixture, "[data-connect]");
    expect(must(sockets[0]).url).toBe("wss://one.test/tenants/beta/signedup");
  });
});
