import { describe, expect, it } from "bun:test";

import type {
  SocketEvent,
  WsFrame,
  WsState,
} from "../src/components/openapi/ws-client.ts";
import { createWsClient } from "../src/components/openapi/ws-client.ts";

/**
 * Tests for the AsyncAPI live-connect state machine
 * (`src/components/openapi/ws-client.ts`). Every socket here is a fake the test
 * drives by hand, so the suite proves the transitions a reader sees without
 * opening a real connection; the last test installs a `WebSocket` stub on
 * `globalThis` to cover the default factory and the default `Date.now` clock.
 */

/** Listeners the client registered, keyed by socket event name. */
type Wiring = Record<string, ((event: SocketEvent) => void)[]>;

/** A `SocketLike` a test drives: records traffic, replays wired listeners. */
interface FakeSocket {
  addEventListener: (
    type: string,
    listener: (event: SocketEvent) => void
  ) => void;
  close: () => void;
  closed: number;
  /** Deliver a socket event, failing loudly when the client wired none. */
  fire: (type: string, event?: SocketEvent) => void;
  send: (data: string) => void;
  sent: string[];
}

const deliver = (wiring: Wiring, type: string, event: SocketEvent): void => {
  const wired = wiring[type];
  if (!wired) {
    throw new Error(`no listener for "${type}"`);
  }
  for (const listener of wired) {
    listener(event);
  }
};

const createFakeSocket = (): FakeSocket => {
  const wiring: Wiring = {};
  const fake: FakeSocket = {
    addEventListener: (type, listener) => {
      wiring[type] = [...(wiring[type] ?? []), listener];
    },
    close: () => {
      fake.closed += 1;
    },
    closed: 0,
    fire: (type, event = {}) => deliver(wiring, type, event),
    send: (data) => {
      fake.sent.push(data);
    },
    sent: [],
  };
  return fake;
};

/** The last recorded item; an empty log means the client never acted. */
const last = <T>(items: T[]): T => {
  const item = items.at(-1);
  if (item === undefined) {
    throw new Error("expected a recorded item");
  }
  return item;
};

/**
 * Stand-in for the DOM `WebSocket` the default factory constructs, so the
 * `new WebSocket(url)` path is exercised without a network or a browser. Events
 * are fired as bare objects, which is exactly what the factory's `in`/`typeof`
 * narrowing has to cope with.
 */
class StubWebSocket {
  static created: StubWebSocket[] = [];
  closed = 0;
  sent: string[] = [];
  url: string;
  #wiring: Wiring = {};

  constructor(url: string) {
    this.url = url;
    StubWebSocket.created.push(this);
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.#wiring[type] = [...(this.#wiring[type] ?? []), listener];
  }

  close(): void {
    this.closed += 1;
  }

  fire(type: string, event: SocketEvent = {}): void {
    deliver(this.#wiring, type, event);
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

/** A client over fake sockets, with the state/frame log the UI would render. */
const setup = () => {
  const frames: WsFrame[] = [];
  const sockets: FakeSocket[] = [];
  const states: [WsState, string | undefined][] = [];
  const urls: string[] = [];
  let tick = 1000;
  const client = createWsClient({
    create: (url) => {
      urls.push(url);
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => {
      tick += 1;
      return tick;
    },
    onFrame: (frame) => frames.push(frame),
    onState: (state, detail) => states.push([state, detail]),
  });
  return { client, frames, sockets, states, urls };
};

describe("createWsClient", () => {
  it("starts idle and reports nothing before connect", () => {
    const { client, states } = setup();
    expect(client.state()).toBe("idle");
    expect(states).toEqual([]);
  });

  it("walks idle -> connecting -> open", () => {
    const { client, sockets, states, urls } = setup();
    client.connect("wss://api.test/stream");
    expect(client.state()).toBe("connecting");
    expect(urls).toEqual(["wss://api.test/stream"]);
    last(sockets).fire("open");
    expect(client.state()).toBe("open");
    expect(states).toEqual([
      ["connecting", undefined],
      ["open", undefined],
    ]);
  });

  it("logs received frames with the injected clock", () => {
    const { client, frames, sockets } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    last(sockets).fire("message", { data: '{"event":"tick"}' });
    last(sockets).fire("message", { data: "second" });
    expect(frames).toEqual([
      { at: 1001, direction: "received", text: '{"event":"tick"}' },
      { at: 1002, direction: "received", text: "second" },
    ]);
  });

  it("stringifies non-string frame data", () => {
    const { client, frames, sockets } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    last(sockets).fire("message", { data: 42 });
    expect(frames).toEqual([{ at: 1001, direction: "received", text: "42" }]);
  });

  it("refuses to send before the socket opens", () => {
    const { client, frames, sockets } = setup();
    client.connect("wss://api.test");
    expect(client.send("hello")).toBe(false);
    expect(last(sockets).sent).toEqual([]);
    expect(frames).toEqual([]);
  });

  it("refuses to send with no socket at all", () => {
    const { client, frames } = setup();
    expect(client.send("hello")).toBe(false);
    expect(frames).toEqual([]);
  });

  it("sends and logs once open", () => {
    const { client, frames, sockets } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    expect(client.send('{"op":"subscribe"}')).toBe(true);
    expect(last(sockets).sent).toEqual(['{"op":"subscribe"}']);
    expect(frames).toEqual([
      { at: 1001, direction: "sent", text: '{"op":"subscribe"}' },
    ]);
  });

  it("keeps the error state when a close follows an error", () => {
    const { client, sockets, states } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("error");
    expect(client.state()).toBe("error");
    last(sockets).fire("close", { code: 1006 });
    expect(client.state()).toBe("error");
    expect(states).toEqual([
      ["connecting", undefined],
      ["error", undefined],
    ]);
  });

  it("reports a close code with its reason", () => {
    const { client, sockets, states } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    last(sockets).fire("close", { code: 1000, reason: "going away" });
    expect(client.state()).toBe("closed");
    expect(last(states)).toEqual(["closed", "1000 going away"]);
  });

  it("reports a close code with no reason", () => {
    const { client, sockets, states } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    last(sockets).fire("close", { code: 1006, reason: "" });
    expect(last(states)).toEqual(["closed", "1006"]);
  });

  it("reports a bare close with no detail", () => {
    const { client, sockets, states } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    last(sockets).fire("close");
    expect(last(states)).toEqual(["closed", undefined]);
  });

  it("ignores a connect while connecting or open", () => {
    const { client, sockets, states } = setup();
    client.connect("wss://api.test");
    client.connect("wss://other.test");
    expect(sockets).toHaveLength(1);
    last(sockets).fire("open");
    client.connect("wss://other.test");
    expect(sockets).toHaveLength(1);
    expect(states).toEqual([
      ["connecting", undefined],
      ["open", undefined],
    ]);
  });

  it("connects again with a fresh socket after a close", () => {
    const { client, sockets, urls } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    last(sockets).fire("close", { code: 1001 });
    client.connect("wss://again.test");
    expect(client.state()).toBe("connecting");
    expect(sockets).toHaveLength(2);
    expect(urls).toEqual(["wss://api.test", "wss://again.test"]);
    last(sockets).fire("open");
    expect(client.state()).toBe("open");
  });

  it("connects again after an error", () => {
    const { client, sockets } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("error");
    client.connect("wss://api.test");
    expect(sockets).toHaveLength(2);
    expect(client.state()).toBe("connecting");
  });

  it("ignores a disconnect while idle", () => {
    const { client, states } = setup();
    client.disconnect();
    expect(client.state()).toBe("idle");
    expect(states).toEqual([]);
  });

  it("closes the socket on disconnect and reports closed", () => {
    const { client, sockets, states } = setup();
    client.connect("wss://api.test");
    last(sockets).fire("open");
    client.disconnect();
    expect(last(sockets).closed).toBe(1);
    expect(client.state()).toBe("closed");
    expect(last(states)).toEqual(["closed", undefined]);
    // The socket's own close event answers our request; it must not double-log.
    last(sockets).fire("close", { code: 1000 });
    expect(states).toHaveLength(3);
    client.disconnect();
    expect(last(sockets).closed).toBe(1);
  });

  it("drives a real WebSocket through the default factory and clock", () => {
    StubWebSocket.created = [];
    const original = Reflect.get(globalThis, "WebSocket");
    Reflect.set(globalThis, "WebSocket", StubWebSocket);
    try {
      const frames: WsFrame[] = [];
      const states: [WsState, string | undefined][] = [];
      const client = createWsClient({
        onFrame: (frame) => frames.push(frame),
        onState: (state, detail) => states.push([state, detail]),
      });
      const before = Date.now();
      client.connect("wss://default.test/socket");
      const socket = last(StubWebSocket.created);
      expect(socket.url).toBe("wss://default.test/socket");
      socket.fire("open");
      expect(client.state()).toBe("open");
      socket.fire("message", { data: "pong" });
      expect(client.send("ping")).toBe(true);
      expect(socket.sent).toEqual(["ping"]);
      socket.fire("error");
      socket.fire("close", { code: 1011, reason: "boom" });
      expect(client.state()).toBe("error");
      client.disconnect();
      expect(socket.closed).toBe(1);
      expect(frames.map((frame) => frame.direction)).toEqual([
        "received",
        "sent",
      ]);
      // The default clock is the wall clock, not one of this suite's fakes.
      for (const frame of frames) {
        expect(frame.at).toBeGreaterThanOrEqual(before);
      }
      expect(states.map(([state]) => state)).toEqual([
        "connecting",
        "open",
        "error",
        "closed",
      ]);
    } finally {
      Reflect.set(globalThis, "WebSocket", original);
    }
  });
});
