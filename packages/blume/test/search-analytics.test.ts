import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import type { TrackProps } from "../src/components/layout/analytics-client.ts";
import {
  MAX_QUERY_CHARS,
  SETTLE_MS,
  createSearchTracker,
} from "../src/components/layout/search/analytics.ts";
import type { SettleTimer } from "../src/components/layout/search/analytics.ts";

/** One event the tracker sent. */
interface Sent {
  event: string;
  /** What only the `blume:track` DOM event carries, when anything. */
  local?: TrackProps;
  props: TrackProps;
}

let sent: Sent[] = [];

/** A timer a test fires by hand. */
const manualTimer = () => {
  const due = new Map<number, () => void>();
  let next = 0;
  const timer: SettleTimer = {
    cancel: (handle) => {
      due.delete(handle);
    },
    start: (callback, ms) => {
      expect(ms).toBe(SETTLE_MS);
      next += 1;
      due.set(next, callback);
      return next;
    },
  };
  return {
    fire: () => {
      const callbacks = [...due.values()];
      due.clear();
      for (const run of callbacks) {
        run();
      }
    },
    pending: () => due.size,
    timer,
  };
};

const tracker = (clock: ReturnType<typeof manualTimer>, queries?: boolean) =>
  createSearchTracker(
    (event, props, local) => {
      sent.push(local ? { event, local, props } : { event, props });
    },
    { queries, timer: clock.timer }
  );

beforeEach(() => {
  sent = [];
  Object.assign(globalThis, { location: { pathname: "/docs/install" } });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
});

describe(createSearchTracker, () => {
  it("records a query once it settles, not every keystroke", () => {
    const clock = manualTimer();
    const search = tracker(clock);
    search.settled("dep", 4);
    search.settled("deploy", 2);
    expect(clock.pending()).toBe(1);
    expect(sent).toStrictEqual([]);
    clock.fire();
    expect(sent).toStrictEqual([
      {
        event: "search",
        props: { path: "/docs/install", query: "deploy", results: 2 },
      },
    ]);
  });

  it("records a pending query when the reader picks a result, then the pick", () => {
    const clock = manualTimer();
    const search = tracker(clock);
    search.settled("sidebar", 5);
    search.selected("sidebar", 2, "/docs/navigation");
    expect(sent.map((entry) => entry.event)).toStrictEqual([
      "search",
      "search_select",
    ]);
    expect(sent[1]?.props).toStrictEqual({
      path: "/docs/install",
      position: 2,
      query: "sidebar",
      url: "/docs/navigation",
    });
    expect(clock.pending()).toBe(0);
  });

  it("records the query showing when the dialog closes, and counts a repeat once", () => {
    const clock = manualTimer();
    const search = tracker(clock);
    search.settled("zzz", 0);
    clock.fire();
    // A filter toggled back and forth settles the same query again.
    search.settled("zzz", 0);
    clock.fire();
    search.closed();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.props.results).toBe(0);
    // A new session may search the same thing and count again.
    search.settled("zzz", 0);
    search.closed();
    expect(sent).toHaveLength(2);
  });

  it("caps a long query", () => {
    const clock = manualTimer();
    const search = tracker(clock);
    const long = "x".repeat(MAX_QUERY_CHARS + 20);
    search.settled(long, 1);
    search.selected(long, 1, "/docs");
    expect(sent.map((entry) => String(entry.props.query).length)).toStrictEqual(
      [MAX_QUERY_CHARS, MAX_QUERY_CHARS]
    );
  });

  it("sends a query's length instead of its text when queries are off", () => {
    const clock = manualTimer();
    const search = tracker(clock, false);
    search.settled("my api key sk-123", 2);
    search.selected("my api key sk-123", 1, "/docs/keys");
    // Providers get the length; the text rides the DOM event alone.
    expect(sent).toStrictEqual([
      {
        event: "search",
        local: { query: "my api key sk-123" },
        props: { path: "/docs/install", queryChars: 17, results: 2 },
      },
      {
        event: "search_select",
        local: { query: "my api key sk-123" },
        props: {
          path: "/docs/install",
          position: 1,
          queryChars: 17,
          url: "/docs/keys",
        },
      },
    ]);
  });

  it("waits on the browser's timer by default", async () => {
    const search = createSearchTracker((event, props) => {
      sent.push({ event, props });
    });
    search.settled("default", 3);
    search.settled("default timer", 3);
    await Bun.sleep(SETTLE_MS + 50);
    expect(sent.map((entry) => entry.props.query)).toStrictEqual([
      "default timer",
    ]);
  });
});

describe("search dialog query analytics", () => {
  it("turns query text off from search.analytics.queries", async () => {
    const source = await readFile(
      new URL("../src/components/layout/Search.astro", import.meta.url),
      { encoding: "utf-8" }
    );
    expect(source).toContain(
      'data-redact-queries={data.config.search.analytics.queries ? undefined : ""}'
    );
    expect(source).toContain(
      'queries: !this.hasAttribute("data-redact-queries")'
    );
  });
});
