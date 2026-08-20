import { afterAll, describe, expect, it, mock } from "bun:test";

// Type-only: erased at runtime, so the module mocks below still apply when
// hooks.ts is actually imported.
import type { BlumeClientData } from "../src/components/islands/hooks.ts";

/**
 * Tests for the `blume/hooks` island hooks (`src/components/islands/hooks.ts`).
 *
 * React hooks need a renderer, but pulling one in just for this would drag a
 * DOM into the suite; instead `react` is module-mocked with a minimal hook
 * runtime (state cells persisting across renders, effects run after each
 * render) so the hooks execute as plain functions. `blume:search-client` is a
 * generated virtual module, mocked the same way.
 */

// hooks.ts resolves the Ask AI endpoint from `import.meta.env.BASE_URL` at
// module scope (Bun aliases `import.meta.env` to `process.env`).
process.env.BASE_URL = "/";

// --- minimal hook runtime -------------------------------------------------

let cells: unknown[] = [];
let cursor = 0;
let effects: (() => void)[] = [];

/** Distinguish the updater form `setState(fn)` from a plain `setState(value)`. */
const isStateUpdater = <T>(
  value: T | ((current: T) => T)
): value is (current: T) => T => typeof value === "function";

mock.module("react", () => ({
  useCallback: <T>(fn: T) => fn,
  useEffect: (effect: () => void) => {
    effects.push(effect);
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

/** Run one "render": reset the cell cursor, call the hook, flush effects. */
const render = <T>(hook: () => T): T => {
  cursor = 0;
  effects = [];
  const value = hook();
  for (const effect of effects) {
    effect();
  }
  return value;
};

/** First render of a fresh component (empty state cells). */
const freshRender = <T>(hook: () => T): T => {
  cells = [];
  return render(hook);
};

// `currentPath()` reads window.location; give the hooks a page to ground on.
// SAFETY: installs a test-only window stub on the global; the hooks read only
// `location.pathname` from it.
(globalThis as { window?: unknown }).window = {
  location: { pathname: "/guide" },
};

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  // SAFETY: removes the window stub installed above.
  delete (globalThis as { window?: unknown }).window;
  // SAFETY: removes the document stubs installed by the snapshot tests.
  delete (globalThis as { document?: unknown }).document;
});

const hooks = await import("../src/components/islands/hooks.ts");
const { useAskAI, useBlume, usePage, useSearch } = hooks;

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

describe("useBlume / usePage", () => {
  it("returns null without the injected snapshot", () => {
    // No `document` in this runtime yet — the SSR guard path.
    freshRender(useBlume);
    expect(render(useBlume)).toBeNull();
  });

  it("returns null when the snapshot script is missing", () => {
    // SAFETY: a document stub answering the one querySelector call the hook
    // makes.
    (globalThis as { document?: unknown }).document = {
      querySelector: () => null,
    };
    freshRender(useBlume);
    expect(render(useBlume)).toBeNull();
  });

  it("returns null when the snapshot is not valid JSON", () => {
    // SAFETY: a document stub answering the one querySelector call the hook
    // makes.
    (globalThis as { document?: unknown }).document = {
      querySelector: () => ({ textContent: "not json" }),
    };
    freshRender(usePage);
    expect(render(usePage)).toBeNull();
  });

  it("reads config, navigation, and page from the snapshot", () => {
    const snapshot: BlumeClientData = {
      // SAFETY: useBlume surfaces the injected config verbatim, so a
      // title-only stub stands in for the full client config.
      config: { title: "Docs" } as BlumeClientData["config"],
      navigation: { featured: [], selectors: [], sidebar: [], tabs: [] },
      page: { route: "/guide", title: "Guide" },
    };
    // SAFETY: a document stub answering the one querySelector call the hook
    // makes.
    (globalThis as { document?: unknown }).document = {
      querySelector: () => ({ textContent: JSON.stringify(snapshot) }),
    };
    freshRender(useBlume);
    expect(render(useBlume)).toStrictEqual({
      config: snapshot.config,
      navigation: snapshot.navigation,
    });
    // The parsed snapshot is memoized; a second hook reads the cache.
    freshRender(usePage);
    expect(render(usePage)).toStrictEqual(snapshot.page);
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

describe("useAskAI", () => {
  const ERROR_MESSAGE =
    "Something went wrong answering that. Please try again.";

  it("streams the answer into the assistant message", async () => {
    const requests: { init?: RequestInit; url: string }[] = [];
    setFetch((url, init) => {
      requests.push({ init, url });
      return Promise.resolve(streamResponse(["Hello ", "world"]));
    });
    const { ask } = freshRender(useAskAI);
    await ask("What is Blume?");
    expect(requests[0]?.url).toBe("/api/ask");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.page).toStrictEqual({ path: "/guide" });
    expect(body.messages).toStrictEqual([
      { content: "What is Blume?", role: "user" },
    ]);
    const { loading, messages } = render(useAskAI);
    expect(loading).toBe(false);
    expect(messages).toStrictEqual([
      { content: "What is Blume?", role: "user" },
      { content: "Hello world", role: "assistant" },
    ]);
  });

  it("replaces the placeholder with an error notice on a non-OK response", async () => {
    setFetch(() => Promise.resolve(new Response("boom", { status: 500 })));
    const { ask } = freshRender(useAskAI);
    await ask("broken?");
    const { loading, messages } = render(useAskAI);
    expect(loading).toBe(false);
    expect(messages).toStrictEqual([
      { content: "broken?", role: "user" },
      { content: ERROR_MESSAGE, role: "assistant" },
    ]);
  });

  it("recovers when fetch itself throws (offline)", async () => {
    setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const { ask } = freshRender(useAskAI);
    // The promise must resolve — a rejection would leave the pre-appended
    // empty assistant message stuck as a placeholder forever.
    await expect(ask("offline?")).resolves.toBeUndefined();
    const { loading, messages } = render(useAskAI);
    expect(loading).toBe(false);
    expect(messages).toStrictEqual([
      { content: "offline?", role: "user" },
      { content: ERROR_MESSAGE, role: "assistant" },
    ]);
  });

  it("ignores empty questions", async () => {
    let called = false;
    setFetch(() => {
      called = true;
      return Promise.resolve(streamResponse([]));
    });
    const { ask } = freshRender(useAskAI);
    await ask("   ");
    expect(called).toBe(false);
    expect(render(useAskAI).messages).toStrictEqual([]);
  });

  it("resets the conversation", async () => {
    setFetch(() => Promise.resolve(streamResponse(["ok"])));
    const { ask } = freshRender(useAskAI);
    await ask("hi");
    const { messages, reset } = render(useAskAI);
    expect(messages).toHaveLength(2);
    reset();
    expect(render(useAskAI).messages).toStrictEqual([]);
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
    const { ask, reset } = freshRender(useAskAI);
    const pending = ask("streaming?");
    await flush();
    controller?.enqueue(encoder.encode("Partial "));
    await flush();
    // Mid-answer: user bubble plus the streaming assistant bubble.
    expect(render(useAskAI).messages).toStrictEqual([
      { content: "streaming?", role: "user" },
      { content: "Partial ", role: "assistant" },
    ]);

    reset();
    expect(render(useAskAI).messages).toStrictEqual([]);
    expect(render(useAskAI).loading).toBe(false);

    // Chunks the revoked stream still delivers must not re-append the
    // assistant bubble onto the emptied conversation.
    controller?.enqueue(encoder.encode("late"));
    controller?.close();
    await pending;
    const after = render(useAskAI);
    expect(after.messages).toStrictEqual([]);
    expect(after.loading).toBe(false);
  });

  it("does not resurrect pre-reset history through the error path", async () => {
    setFetch(() => Promise.resolve(streamResponse(["ok"])));
    const initial = freshRender(useAskAI);
    await initial.ask("hi");
    // Re-render so `ask` sees the settled conversation; `ask` and `reset`
    // share this render's generation guard.
    const mid = render(useAskAI);
    expect(mid.messages).toHaveLength(2);

    const gate = Promise.withResolvers<Response>();
    setFetch(() => gate.promise);
    const pending = mid.ask("more?");
    mid.reset();
    expect(render(useAskAI).messages).toStrictEqual([]);

    // The failure lands after the reset: its catch must not write the
    // pre-reset history (plus error notice) back into the emptied state.
    gate.reject(new TypeError("Failed to fetch"));
    await expect(pending).resolves.toBeUndefined();
    const after = render(useAskAI);
    expect(after.messages).toStrictEqual([]);
    expect(after.loading).toBe(false);
  });
});
