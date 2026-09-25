import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

// Type-only: erased at runtime, so the module mocks below still apply when
// hooks.ts is actually imported.
import type { BlumeClientData } from "../src/components/islands/hooks.ts";
import type { TrackProps } from "../src/components/layout/analytics-client.ts";

/**
 * Tests for the `blume/hooks` island hooks (`src/components/islands/hooks.ts`).
 *
 * React hooks need a renderer, but pulling one in just for this would drag a
 * DOM into the suite; instead `react` is module-mocked with a minimal hook
 * runtime (state cells persisting across renders, effects run after each
 * render) so the hooks execute as plain functions. `blume:search-client` is a
 * generated virtual module, mocked the same way.
 */

// hooks.ts resolves the assistant endpoint from `import.meta.env.BASE_URL` at
// module scope (Bun aliases `import.meta.env` to `process.env`).
process.env.BASE_URL = "/";

// --- minimal hook runtime -------------------------------------------------

let cells: unknown[] = [];
let cursor = 0;
/** What the mocked useEffect stores: an effect returning an optional cleanup. */
type Effect = () => (() => void) | undefined;
/** A queued effect and whether its deps (`[]`) limit it to the first render. */
let effects: { effect: Effect; once: boolean }[] = [];
let cleanups: (() => void)[] = [];
/** Whether the current component has rendered (and run its mount effects). */
let mounted = false;

/** Distinguish the updater form `setState(fn)` from a plain `setState(value)`. */
const isStateUpdater = <T>(
  value: T | ((current: T) => T)
): value is (current: T) => T => typeof value === "function";

mock.module("react", () => ({
  useCallback: <T>(fn: T) => fn,
  useEffect: (effect: Effect, deps?: unknown[]) => {
    effects.push({ effect, once: deps?.length === 0 });
  },
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(initial: T) => {
    const index = cursor;
    cursor += 1;
    if (!(index in cells)) {
      cells[index] = initial;
    }
    const set = (update: T | ((current: T) => T)) => {
      // SAFETY: cell `index` is owned by this useState call, so it always
      // holds that hook's T across renders.
      cells[index] = isStateUpdater(update)
        ? update(cells[index] as T)
        : update;
    };
    return [cells[index], set];
  },
}));

/** The result shape the mocked provider returns for `query`. */
const hitFor = (query: string) => ({
  hits: [{ excerpt: "", title: query, url: "/hit" }],
  sections: [],
});

/** What the mocked provider yields for a query, sync or via a promise. */
type SearchOutcome = ReturnType<typeof hitFor>;

// Both call sites in `useSearch` await their results, so plain returns work.
// The implementation is swappable so the race tests can control when (and in
// which order) each query's response lands.
let searchImpl: (query: string) => SearchOutcome | Promise<SearchOutcome> =
  hitFor;
mock.module("blume:search-client", () => ({
  createSearch: () => (query: string) => searchImpl(query),
}));

/** Run every collected effect cleanup, as an unmount would. */
const unmount = () => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
};

/**
 * Run one "render": reset the cell cursor, call the hook, flush effects. A
 * mount-only effect (`[]` deps) runs on the component's first render alone, so
 * a later render can't mask a subscription the hook forgot to make.
 */
const render = <T>(hook: () => T): T => {
  cursor = 0;
  effects = [];
  const value = hook();
  for (const { effect, once } of effects) {
    if (!(once && mounted)) {
      const cleanup = effect();
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }
  }
  mounted = true;
  return value;
};

/** First render of a fresh component (empty state cells). */
const freshRender = <T>(hook: () => T): T => {
  unmount();
  cells = [];
  mounted = false;
  return render(hook);
};

/** An analytics event as one provider (or the `blume:track` detail) saw it. */
interface Tracked {
  event: string;
  props: TrackProps;
}

/**
 * Analytics events the hooks report, captured through the PostHog global the
 * real `track()` helper fans out to (module-mocking the helper would leak into
 * its own test file, since Bun shares module mocks across a run).
 */
const tracked: Tracked[] = [];

/** The same events as the `blume:track` CustomEvent carries them. */
const dispatched: Tracked[] = [];

// `currentPath()` reads window.location; give the hooks a page to ground on,
// and `track()` a PostHog stub plus the `dispatchEvent` its universal hook
// needs.
const windowStub = {
  dispatchEvent: (event: CustomEvent): boolean => {
    // SAFETY: `track()` is the only dispatcher here, and its detail is always
    // `{ event, props }`.
    dispatched.push(event.detail as Tracked);
    return true;
  },
  location: { pathname: "/guide" },
  posthog: {
    capture: (event: string, props: TrackProps): void => {
      tracked.push({ event, props });
    },
  },
};
// SAFETY: installs a test-only window stub on the global; the hooks read only
// `location.pathname` from it and the analytics helper only the stubs above.
(globalThis as { window?: unknown }).window = windowStub;

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  // SAFETY: removes the window stub installed above.
  delete (globalThis as { window?: unknown }).window;
  // SAFETY: removes the document stubs installed by the snapshot tests.
  delete (globalThis as { document?: unknown }).document;
});

const hooks = await import("../src/components/islands/hooks.ts");
const { useAssistant, useBlume, usePage, useSearch } = hooks;

/** A streaming 200 response delivering `chunks` through a ReadableStream. */
const streamResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 }
  );
};

const setFetch = (
  handler: (url: string, init?: RequestInit) => Promise<Response>
) => {
  // SAFETY: the hooks call fetch with (url, init) only; the extra statics on
  // Bun's fetch type (e.g. `preconnect`) are never touched.
  globalThis.fetch = handler as typeof fetch;
};

/**
 * Yield a macrotask: every pending microtask flushes first, letting an
 * in-flight `ask` advance to (or past) its next `reader.read()`.
 */
const flush = (): Promise<void> => Bun.sleep(0);

/** The snapshot `<script>` tag as the hooks read it; `null` when absent. */
interface SnapshotTag {
  textContent: string;
}

/** Document listeners the snapshot hooks subscribed (the client-router swap). */
const documentListeners = new Map<string, Set<() => void>>();

/** Install a document whose `#blume-client-data` lookup answers `tag`. */
const stubDocument = (tag: SnapshotTag | null) => {
  documentListeners.clear();
  // SAFETY: a document stub answering the querySelector call and the swap
  // subscription the hooks make.
  (globalThis as { document?: unknown }).document = {
    addEventListener: (type: string, listener: () => void) => {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    querySelector: () => tag,
    removeEventListener: (type: string, listener: () => void) => {
      documentListeners.get(type)?.delete(listener);
    },
  };
};

/** Deliver a document event to the hooks' live listeners. */
const dispatchDocument = (type: string) => {
  for (const listener of documentListeners.get(type) ?? []) {
    listener();
  }
};

/** A page's snapshot: the shared config, its navigation, and its route. */
const snapshotFor = (
  route: string,
  title: string,
  sidebar: BlumeClientData["navigation"]["sidebar"] = []
): BlumeClientData => ({
  // SAFETY: useBlume surfaces the injected config verbatim, so a title-only
  // stub stands in for the full client config.
  config: { title: "Docs" } as BlumeClientData["config"],
  navigation: { featured: [], selectors: [], sidebar, tabs: [] },
  page: { route, title },
});

describe("useBlume / usePage", () => {
  it("returns null without the injected snapshot", () => {
    // No `document` in this runtime yet — the SSR guard path.
    freshRender(useBlume);
    expect(render(useBlume)).toBeNull();
  });

  it("returns null when the snapshot script is missing", () => {
    stubDocument(null);
    freshRender(useBlume);
    expect(render(useBlume)).toBeNull();
  });

  it("returns null when the snapshot is not valid JSON", () => {
    stubDocument({ textContent: "not json" });
    freshRender(usePage);
    expect(render(usePage)).toBeNull();
  });

  it("reads config, navigation, and page from the snapshot", () => {
    const snapshot = snapshotFor("/guide", "Guide");
    stubDocument({ textContent: JSON.stringify(snapshot) });
    freshRender(useBlume);
    expect(render(useBlume)).toStrictEqual({
      config: snapshot.config,
      navigation: snapshot.navigation,
    });
    // The parsed snapshot is memoized; a second hook reads the cache.
    freshRender(usePage);
    const page = render(usePage);
    expect(page).toStrictEqual(snapshot.page);
    freshRender(usePage);
    expect(render(usePage)).toBe(page);
  });

  it("reads the next page's snapshot after a client-router navigation", () => {
    const guide = snapshotFor("/guide", "Guide");
    const tag = { textContent: JSON.stringify(guide) };
    stubDocument(tag);
    freshRender(usePage);
    expect(render(usePage)).toStrictEqual(guide.page);

    // The swap installs /api's body, and with it /api's own snapshot. An
    // island on /api mounts fresh and must read that, not the cached /guide.
    const api = snapshotFor("/api", "API", [
      { kind: "page", label: "API", pageId: "api", route: "/api" },
    ]);
    tag.textContent = JSON.stringify(api);
    freshRender(usePage);
    expect(render(usePage)).toStrictEqual(api.page);
    freshRender(useBlume);
    expect(render(useBlume)?.navigation).toStrictEqual(api.navigation);
  });

  it("updates a persisted island's hooks when a swap brings a new snapshot", () => {
    const guide = snapshotFor("/guide", "Guide");
    const tag = { textContent: JSON.stringify(guide) };
    stubDocument(tag);
    freshRender(usePage);
    expect(render(usePage)).toStrictEqual(guide.page);

    // A `transition:persist` island stays mounted across the navigation, so
    // no mount effect re-runs; only the swap subscription can refresh it.
    const api = snapshotFor("/api", "API");
    tag.textContent = JSON.stringify(api);
    expect(render(usePage)).toStrictEqual(guide.page);
    dispatchDocument("astro:after-swap");
    expect(render(usePage)).toStrictEqual(api.page);

    // Unmounting drops the subscription.
    unmount();
    expect(documentListeners.get("astro:after-swap")?.size).toBe(0);
  });
});

describe("useSearch", () => {
  it("lazily creates the provider client and stores results", async () => {
    const first = freshRender(useSearch);
    const result = await first.search("astro", { locale: "en" });
    expect(result).toStrictEqual({
      hits: [{ excerpt: "", title: "astro", url: "/hit" }],
      sections: [],
    });
    const next = render(useSearch);
    expect(next.loading).toBe(false);
    expect(next.results).toStrictEqual(result);
    // Second search reuses the created client.
    await next.search("blume");
    expect(render(useSearch).results).toStrictEqual({
      hits: [{ excerpt: "", title: "blume", url: "/hit" }],
      sections: [],
    });
  });

  it("reports loading during the initial client creation", async () => {
    const { search } = freshRender(useSearch);
    const pending = search("astro");
    // `loading` flips on synchronously, before the lazy client import — the
    // first search's index download must not show as idle.
    expect(render(useSearch).loading).toBe(true);
    await pending;
    expect(render(useSearch).loading).toBe(false);
  });

  it("ignores a stale response that lands after a newer query's", async () => {
    const a = Promise.withResolvers<SearchOutcome>();
    const ab = Promise.withResolvers<SearchOutcome>();
    searchImpl = (query) => (query === "a" ? a.promise : ab.promise);
    try {
      const { search } = freshRender(useSearch);
      const first = search("a");
      const second = search("ab");

      // The newer query answers first and wins.
      ab.resolve(hitFor("ab"));
      await second;
      expect(render(useSearch).results).toStrictEqual(hitFor("ab"));
      expect(render(useSearch).loading).toBe(false);

      // The stale response lands afterwards: it must not clobber the newer
      // results or re-touch `loading` (it still resolves its own caller).
      a.resolve(hitFor("a"));
      await expect(first).resolves.toStrictEqual(hitFor("a"));
      expect(render(useSearch).results).toStrictEqual(hitFor("ab"));
      expect(render(useSearch).loading).toBe(false);
    } finally {
      searchImpl = hitFor;
    }
  });

  it("keeps loading while a newer query is still in flight", async () => {
    const a = Promise.withResolvers<SearchOutcome>();
    const ab = Promise.withResolvers<SearchOutcome>();
    searchImpl = (query) => (query === "a" ? a.promise : ab.promise);
    try {
      const { search } = freshRender(useSearch);
      const first = search("a");
      const second = search("ab");

      // The stale query settles first: its `finally` must not clear the
      // loading state the in-flight newer query still owns.
      a.resolve(hitFor("a"));
      await first;
      expect(render(useSearch).loading).toBe(true);

      ab.resolve(hitFor("ab"));
      await second;
      expect(render(useSearch).loading).toBe(false);
      expect(render(useSearch).results).toStrictEqual(hitFor("ab"));
    } finally {
      searchImpl = hitFor;
    }
  });
});

describe("useAssistant", () => {
  const ERROR_MESSAGE =
    "Something went wrong answering that. Please try again.";

  beforeEach(() => {
    tracked.length = 0;
    dispatched.length = 0;
  });

  it("streams the answer into the assistant message", async () => {
    const requests: { init?: RequestInit; url: string }[] = [];
    setFetch((url, init) => {
      requests.push({ init, url });
      return Promise.resolve(streamResponse(["Hello ", "world"]));
    });
    const { ask } = freshRender(useAssistant);
    await ask("What is Blume?");
    // The question and its outcome reach analytics, like page feedback.
    // Providers get the question's length; only the `blume:track` event
    // carries its text.
    expect(tracked).toStrictEqual([
      { event: "ask", props: { path: "/guide", questionChars: 14 } },
      {
        event: "ask_answer",
        props: {
          chars: 11,
          ms: expect.any(Number),
          path: "/guide",
          questionChars: 14,
        },
      },
    ]);
    expect(dispatched[0]).toStrictEqual({
      event: "ask",
      props: { path: "/guide", question: "What is Blume?", questionChars: 14 },
    });
    expect(dispatched[1]?.props.question).toBe("What is Blume?");
    // Latency comes from a monotonic clock, rounded to whole milliseconds.
    const { ms } = tracked[1]?.props ?? {};
    expect(ms).toBe(Math.round(Number(ms)));
    expect(Number(ms)).toBeGreaterThanOrEqual(0);
    expect(requests[0]?.url).toBe("/api/ask");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.page).toStrictEqual({ path: "/guide" });
    expect(body.messages).toStrictEqual([
      { content: "What is Blume?", role: "user" },
    ]);
    const { loading, messages } = render(useAssistant);
    expect(loading).toBe(false);
    expect(messages).toStrictEqual([
      { content: "What is Blume?", role: "user" },
      { content: "Hello world", role: "assistant" },
    ]);
  });

  it("replaces the placeholder with an error notice on a non-OK response", async () => {
    setFetch(() => Promise.resolve(new Response("boom", { status: 500 })));
    const { ask } = freshRender(useAssistant);
    await ask("broken?");
    const { loading, messages } = render(useAssistant);
    expect(loading).toBe(false);
    expect(messages).toStrictEqual([
      { content: "broken?", role: "user" },
      { content: ERROR_MESSAGE, role: "assistant" },
    ]);
    expect(tracked.map((entry) => entry.event)).toStrictEqual([
      "ask",
      "ask_error",
    ]);
    expect(tracked[1]?.props).toMatchObject({
      questionChars: 7,
      status: 500,
    });
  });

  it("reports the HTTP status when the stream breaks after a 200", async () => {
    // `streamText` defers provider errors to the stream, so the backend's
    // most common failure is a 200 whose body aborts mid-flight — that must
    // read as a 200 error in analytics, not as "no response".
    const encoder = new TextEncoder();
    setFetch(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("Part"));
              controller.error(new Error("provider rejected the key"));
            },
          }),
          { status: 200 }
        )
      )
    );
    const { ask } = freshRender(useAssistant);
    await ask("mid-flight?");
    expect(render(useAssistant).messages).toStrictEqual([
      { content: "mid-flight?", role: "user" },
      { content: ERROR_MESSAGE, role: "assistant" },
    ]);
    expect(tracked[1]).toMatchObject({
      event: "ask_error",
      props: { status: 200 },
    });
  });

  it("reports an empty 200 as an error, not an answer", async () => {
    // No body at all, and a stream that closes without a byte (how a
    // provider failure after the 200 arrives): neither counts as an answer,
    // and the reader gets the error notice instead of a blank bubble.
    setFetch(() => Promise.resolve(new Response(null, { status: 200 })));
    const first = freshRender(useAssistant);
    await first.ask("nothing?");
    expect(tracked.map((entry) => entry.event)).toStrictEqual([
      "ask",
      "ask_error",
    ]);
    expect(tracked[1]?.props).toMatchObject({ status: 200 });
    expect(render(useAssistant).messages).toStrictEqual([
      { content: "nothing?", role: "user" },
      { content: ERROR_MESSAGE, role: "assistant" },
    ]);

    tracked.length = 0;
    setFetch(() => Promise.resolve(streamResponse([])));
    const second = freshRender(useAssistant);
    await second.ask("still nothing?");
    expect(tracked.map((entry) => entry.event)).toStrictEqual([
      "ask",
      "ask_error",
    ]);
    expect(tracked[1]?.props).toMatchObject({ status: 200 });
    expect(render(useAssistant).messages).toStrictEqual([
      { content: "still nothing?", role: "user" },
      { content: ERROR_MESSAGE, role: "assistant" },
    ]);
  });

  it("keys analytics on the raw pathname under a deployment base", async () => {
    // The endpoint gets the base-stripped route for grounding, but analytics
    // must match the feedback widget and the providers' pageviews, which
    // record the served pathname.
    const { BASE_URL } = process.env;
    const { pathname } = windowStub.location;
    process.env.BASE_URL = "/docs";
    windowStub.location.pathname = "/docs/guide";
    try {
      const requests: { init?: RequestInit }[] = [];
      setFetch((_url, init) => {
        requests.push({ init });
        return Promise.resolve(streamResponse(["ok"]));
      });
      const { ask } = freshRender(useAssistant);
      await ask("based?");
      const body = JSON.parse(String(requests[0]?.init?.body));
      expect(body.page).toStrictEqual({ path: "/guide" });
      expect(tracked[0]?.props.path).toBe("/docs/guide");
      expect(tracked[1]?.props.path).toBe("/docs/guide");
    } finally {
      process.env.BASE_URL = BASE_URL;
      windowStub.location.pathname = pathname;
    }
  });

  it("recovers when fetch itself throws (offline)", async () => {
    setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const { ask } = freshRender(useAssistant);
    // The promise must resolve — a rejection would leave the pre-appended
    // empty assistant message stuck as a placeholder forever.
    await expect(ask("offline?")).resolves.toBeUndefined();
    const { loading, messages } = render(useAssistant);
    expect(loading).toBe(false);
    expect(messages).toStrictEqual([
      { content: "offline?", role: "user" },
      { content: ERROR_MESSAGE, role: "assistant" },
    ]);
    // No response at all reports status 0.
    expect(tracked[1]).toMatchObject({
      event: "ask_error",
      props: { questionChars: 8, status: 0 },
    });
  });

  it("ignores empty questions", async () => {
    let called = false;
    setFetch(() => {
      called = true;
      return Promise.resolve(streamResponse([]));
    });
    const { ask } = freshRender(useAssistant);
    await ask("   ");
    expect(called).toBe(false);
    expect(render(useAssistant).messages).toStrictEqual([]);
    expect(tracked).toStrictEqual([]);
  });

  it("resets the conversation", async () => {
    setFetch(() => Promise.resolve(streamResponse(["ok"])));
    const { ask } = freshRender(useAssistant);
    await ask("hi");
    const { messages, reset } = render(useAssistant);
    expect(messages).toHaveLength(2);
    reset();
    expect(render(useAssistant).messages).toStrictEqual([]);
  });

  it("discards stream chunks that land after a mid-answer reset", async () => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    setFetch(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
            },
          }),
          { status: 200 }
        )
      )
    );
    // `ask` and `reset` must come from the same render so they share the
    // generation guard.
    const { ask, reset } = freshRender(useAssistant);
    const pending = ask("streaming?");
    await flush();
    controller?.enqueue(encoder.encode("Partial "));
    await flush();
    // Mid-answer: user bubble plus the streaming assistant bubble.
    expect(render(useAssistant).messages).toStrictEqual([
      { content: "streaming?", role: "user" },
      { content: "Partial ", role: "assistant" },
    ]);

    reset();
    expect(render(useAssistant).messages).toStrictEqual([]);
    expect(render(useAssistant).loading).toBe(false);

    // Chunks the revoked stream still delivers must not re-append the
    // assistant bubble onto the emptied conversation.
    controller?.enqueue(encoder.encode("late"));
    controller?.close();
    await pending;
    const after = render(useAssistant);
    expect(after.messages).toStrictEqual([]);
    expect(after.loading).toBe(false);
    // A reset revokes the outcome along with the UI update: the question was
    // asked, but it was neither answered nor failed.
    expect(tracked.map((entry) => entry.event)).toStrictEqual(["ask"]);
  });

  it("does not resurrect pre-reset history through the error path", async () => {
    setFetch(() => Promise.resolve(streamResponse(["ok"])));
    const initial = freshRender(useAssistant);
    await initial.ask("hi");
    // Re-render so `ask` sees the settled conversation; `ask` and `reset`
    // share this render's generation guard.
    const mid = render(useAssistant);
    expect(mid.messages).toHaveLength(2);

    const gate = Promise.withResolvers<Response>();
    setFetch(() => gate.promise);
    const pending = mid.ask("more?");
    mid.reset();
    expect(render(useAssistant).messages).toStrictEqual([]);

    // The failure lands after the reset: its catch must not write the
    // pre-reset history (plus error notice) back into the emptied state.
    gate.reject(new TypeError("Failed to fetch"));
    await expect(pending).resolves.toBeUndefined();
    const after = render(useAssistant);
    expect(after.messages).toStrictEqual([]);
    expect(after.loading).toBe(false);
  });
});
