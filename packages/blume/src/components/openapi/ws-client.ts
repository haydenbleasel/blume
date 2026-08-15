/**
 * WebSocket state machine behind the AsyncAPI message composer's live connect,
 * used only for operations whose channel has a `ws`/`wss` server. Framework-
 * free and dependency-free like the rest of the playground client code, and it
 * never touches the `WebSocket` global at import time — the constructor is
 * reached solely inside the default factory, so this module imports cleanly in
 * the test runner and on the server during the Astro build.
 *
 * The socket factory and the clock are injectable because both are the parts a
 * test cannot afford to use for real: `create` lets a suite drive open/message/
 * error/close by hand instead of dialing a network, and `now` makes frame
 * timestamps deterministic instead of wall-clock noise.
 *
 * v1 deliberately has no reconnect, no send queue, and no timers. A docs reader
 * connecting to a demo broker wants to see exactly what the socket did — a
 * silent retry loop would hide the very close code they are debugging, and
 * reconnect policy belongs to the API's own client library, not to a docs page.
 */

export type WsState = "idle" | "connecting" | "open" | "closed" | "error";

export interface WsFrame {
  /** Wall-clock ms when the frame was logged. */
  at: number;
  direction: "received" | "sent";
  text: string;
}

/** One socket event, reduced to the fields the client reads. */
export interface SocketEvent {
  code?: number;
  data?: unknown;
  reason?: string;
}

/** The subset of WebSocket the client drives; lets tests inject a fake. */
export interface SocketLike {
  addEventListener: (
    type: string,
    listener: (event: SocketEvent) => void
  ) => void;
  close: () => void;
  send: (data: string) => void;
}

export interface WsClientOptions {
  /** Socket factory; defaults to `new WebSocket(url)`. */
  create?: (url: string) => SocketLike;
  /** Clock for frame timestamps; defaults to `Date.now`. */
  now?: () => number;
  onFrame: (frame: WsFrame) => void;
  /** State transitions, with an optional human detail (close reason/code). */
  onState: (state: WsState, detail?: string) => void;
}

export interface WsClient {
  /** Open a socket. A no-op while `connecting` or `open`. */
  connect: (url: string) => void;
  /** Close the socket if any; state goes to `closed`. */
  disconnect: () => void;
  /** Send text; false when the socket is not open (nothing is logged then). */
  send: (text: string) => boolean;
  state: () => WsState;
}

/**
 * Adapt a real `WebSocket` to `SocketLike`. Each DOM event is reduced to the
 * three fields the client reads, discovered with `in`/`typeof` guards: the DOM
 * types would need a cast to reach `code`/`data`/`reason` off a bare `Event`,
 * and a cast here would let the rest of the module drift onto browser-only
 * surface it has no business using.
 */
const defaultCreate = (url: string): SocketLike => {
  const socket = new WebSocket(url);
  return {
    addEventListener: (type, listener) => {
      socket.addEventListener(type, (event) => {
        const reduced: SocketEvent = {};
        if ("code" in event && typeof event.code === "number") {
          reduced.code = event.code;
        }
        if ("data" in event) {
          reduced.data = event.data;
        }
        if ("reason" in event && typeof event.reason === "string") {
          reduced.reason = event.reason;
        }
        listener(reduced);
      });
    },
    close: () => {
      socket.close();
    },
    send: (data) => {
      socket.send(data);
    },
  };
};

/**
 * Create the client. Nothing happens until `connect` — constructing one during
 * page setup must not dial anything, since most readers never press Connect.
 */
export const createWsClient = (options: WsClientOptions): WsClient => {
  const create = options.create ?? defaultCreate;
  const now = options.now ?? Date.now;
  let socket: SocketLike | null = null;
  let state: WsState = "idle";

  const transition = (next: WsState, detail?: string): void => {
    state = next;
    options.onState(next, detail);
  };

  const connect = (url: string): void => {
    if (state === "connecting" || state === "open") {
      return;
    }
    transition("connecting");
    const next = create(url);
    socket = next;
    // Every listener below is scoped to the socket it was wired for: a browser
    // can deliver a discarded socket's error/close/message after `disconnect`
    // or after the reader reconnected, and replaying those would report the
    // dead connection's fate as the live one's.
    const stale = (): boolean => socket !== next;
    next.addEventListener("open", () => {
      if (stale()) {
        return;
      }
      transition("open");
    });
    next.addEventListener("message", (event) => {
      if (stale()) {
        return;
      }
      options.onFrame({
        at: now(),
        direction: "received",
        // Binary frames arrive as Blob/ArrayBuffer; showing their stringified
        // form beats showing nothing while the reader debugs a payload.
        text: typeof event.data === "string" ? event.data : String(event.data),
      });
    });
    next.addEventListener("error", () => {
      if (stale()) {
        return;
      }
      transition("error");
    });
    next.addEventListener("close", (event) => {
      // Once settled, stay settled: browsers always follow an error event with
      // a close event, and the error is the message worth keeping. A close that
      // answers our own `disconnect` has been reported already.
      if (stale() || state === "error" || state === "closed") {
        return;
      }
      // Code plus the reason when the server bothered to send one; a bare
      // close stays blank so the UI says just "closed", not a meaningless "0".
      const detail = [event.code, event.reason].filter(
        (part) => part !== undefined && part !== ""
      );
      transition("closed", detail.length > 0 ? detail.join(" ") : undefined);
    });
  };

  const disconnect = (): void => {
    if (!socket) {
      return;
    }
    socket.close();
    socket = null;
    transition("closed");
  };

  const send = (text: string): boolean => {
    if (state !== "open") {
      return false;
    }
    socket?.send(text);
    options.onFrame({ at: now(), direction: "sent", text });
    return true;
  };

  return { connect, disconnect, send, state: () => state };
};
