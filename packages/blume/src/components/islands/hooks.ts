import { useCallback, useEffect, useRef, useState } from "react";

import type { BlumeClientData } from "../../core/data.ts";
import { track } from "../layout/analytics-client.ts";
import type { SearchFn, SearchResult } from "../layout/search/types.ts";
import { joinBase, stripBase } from "./base-path.ts";

/**
 * React hooks for Blume islands.
 *
 * Islands hydrate independently (there's no shared React root spanning them), so
 * project data can't come through context. Instead the layout serializes a small
 * snapshot into a `<script type="application/json" id="blume-client-data">` tag,
 * and {@link useBlume}/{@link usePage} read it after mount. {@link useSearch} and
 * {@link useAssistant} wrap the generated search client and the assistant endpoint.
 *
 * Import them from `blume/hooks`:
 *
 * ```tsx
 * import { useBlume, usePage } from "blume/hooks";
 * ```
 */

export type { BlumeClientData } from "../../core/data.ts";

/**
 * The last parsed snapshot, keyed by the script text it came from. Each page
 * renders its own snapshot (its route and title, its locale's navigation), and
 * a client-router navigation swaps in the new page's tag, so the cache is only
 * reused while the tag's text is unchanged.
 */
let cached: { data: BlumeClientData; text: string } | null = null;

/** Read + parse the current page's injected snapshot (memoized per text). */
const readClientData = (): BlumeClientData | null => {
  const text = document.querySelector("#blume-client-data")?.textContent;
  if (!text) {
    return null;
  }
  if (cached?.text === text) {
    return cached.data;
  }
  try {
    // SAFETY: the layout serialized this script tag's JSON from the same
    // `BlumeClientData` snapshot this reads back.
    const data = JSON.parse(text) as BlumeClientData;
    cached = { data, text };
    return data;
  } catch {
    return null;
  }
};

/**
 * Read the injected snapshot after mount. `null` on the server and on the first
 * client render (so hydration matches), then the data once mounted, re-read
 * after every client-router swap.
 */
const useClientData = (): BlumeClientData | null => {
  const [data, setData] = useState<BlumeClientData | null>(null);
  useEffect(() => {
    // `document` is undeclared on the server; probing `globalThis` avoids both
    // the bare-reference ReferenceError and a `typeof` sniff.
    if (!("document" in globalThis)) {
      return;
    }
    const sync = () => setData(readClientData());
    // Intentional post-mount hydration guard: `null` on the server and first
    // client render so hydration matches, then the snapshot once mounted. The
    // extra render is required; do not seed the initial value from the DOM.
    // oxlint-disable-next-line react/react-compiler, react/set-state-in-effect, react-doctor/no-initialize-state -- deliberate SSR hydration guard
    sync();
    // An island kept across navigations (`transition:persist`) outlives the
    // page it mounted on; the swap brings the next page's snapshot, so read
    // it again or the hook keeps answering with the first page's data.
    document.addEventListener("astro:after-swap", sync);
    return () => document.removeEventListener("astro:after-swap", sync);
  }, []);
  return data;
};

/** Site config + navigation for the current page, or `null` before mount. */
export const useBlume = (): Pick<
  BlumeClientData,
  "config" | "navigation"
> | null => {
  const data = useClientData();
  return data ? { config: data.config, navigation: data.navigation } : null;
};

/** The current page's route + title, or `null` before mount. */
export const usePage = (): BlumeClientData["page"] | null =>
  useClientData()?.page ?? null;

/** State + actions returned by {@link useSearch}. */
export interface UseSearch {
  loading: boolean;
  results: SearchResult | null;
  search: (
    query: string,
    options?: { locale?: string; section?: string }
  ) => Promise<SearchResult>;
}

/**
 * Query the site's configured search provider. The provider client is created
 * lazily on the first search, so islands that never search ship no extra weight.
 */
export const useSearch = (): UseSearch => {
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const searchFn = useRef<SearchFn | null>(null);
  const generation = useRef(0);

  // Retained for the compiler-off opt-out path (`react: { compiler: false }`):
  // this useCallback keeps a stable `search` identity for consumers that use it
  // as an effect/memo dependency. With the compiler on it's redundant but inert.
  // oxlint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- see above
  const search = useCallback<UseSearch["search"]>(async (query, options) => {
    // Stale-response guard, mirroring the built-in dialog's renderGeneration:
    // provider responses can land out of order, so only the latest call may
    // commit results or clear `loading` — otherwise the last response to land
    // wins over the last query typed ("a" clobbering "ab").
    generation.current += 1;
    const { current } = generation;
    // Before the lazy client import: the first search's heaviest phase is
    // creating the provider client (index download), and it must show loading.
    setLoading(true);
    // oxlint-disable-next-line react/todo -- React Compiler cannot lower try/finally; the hook stays manually memoized above
    try {
      if (!searchFn.current) {
        const { createSearch } = await import("blume:search-client");
        searchFn.current = await createSearch();
      }
      const result = await searchFn.current(query, options);
      if (current === generation.current) {
        setResults(result);
      }
      return result;
    } finally {
      if (current === generation.current) {
        setLoading(false);
      }
    }
  }, []);

  return { loading, results, search };
};

/** A single assistant chat message. */
export interface AskMessage {
  content: string;
  role: "assistant" | "user";
}

/** State + actions returned by {@link useAssistant}. */
export interface UseAssistant {
  ask: (question: string) => Promise<void>;
  loading: boolean;
  messages: AskMessage[];
  reset: () => void;
}

const DEFAULT_ASK_ENDPOINT = joinBase(import.meta.env.BASE_URL, "api/ask");

export interface UseAssistantOptions {
  /** Existing assistant endpoint; defaults to Blume's generated `/api/ask`. */
  endpoint?: string;
  /**
   * Shown as the assistant's answer when the request fails or throws.
   * Defaults to an English notice; the built-in island passes its localized
   * dictionary string.
   */
  errorMessage?: string;
}

/** Shown as the assistant's answer when the request fails or throws. */
const ASK_ERROR = "Something went wrong answering that. Please try again.";

/** How the assistant's generated route opens its missing-credential notice. */
const NOT_CONFIGURED = /^The assistant is not configured/u;

/**
 * The route's own explanation of a 503 — the generated route's "The assistant is not
 * configured: set AI_GATEWAY_API_KEY." — when the response is that notice, or
 * null. It names only the variable to set, never a value, so it's safe to
 * show, and it tells a site owner trying a fresh deploy what's missing instead
 * of the generic failure; any other error body (an HTML error page, a proxy's
 * message) still gets the generic notice.
 */
const unavailableNotice = async (
  response: Response
): Promise<string | null> => {
  if (response.status !== 503) {
    return null;
  }
  const body = await response.text();
  const text = body.trim();
  return NOT_CONFIGURED.test(text) && text.length <= 200 ? text : null;
};

/** The current route with the deployment base stripped, for page grounding. */
const currentPath = (): string =>
  stripBase(import.meta.env.BASE_URL, window.location.pathname);

/**
 * Stream answers from the assistant endpoint. Mirrors the built-in assistant island so
 * a custom chat UI shares the same grounded, page-aware backend.
 */
export const useAssistant = (
  options: UseAssistantOptions = {}
): UseAssistant => {
  const endpoint = options.endpoint ?? DEFAULT_ASK_ENDPOINT;
  const errorMessage = options.errorMessage ?? ASK_ERROR;
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [loading, setLoading] = useState(false);
  // The stream writes into the conversation via state updates, so `reset()`
  // mid-answer must revoke the in-flight request's right to write — otherwise
  // its next chunk re-appends the assistant bubble onto the emptied list, and
  // its error path resurrects the entire pre-reset history. Mirrors the
  // built-in island's generation/abort guard.
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Retained for the compiler-off opt-out path (`react: { compiler: false }`):
  // preserves a stable `ask` identity for consumers that depend on it. With the
  // compiler on it's redundant but inert.
  // oxlint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- see above
  const ask = useCallback<UseAssistant["ask"]>(
    async (question) => {
      const trimmed = question.trim();
      if (!trimmed || loading) {
        return;
      }
      generation.current += 1;
      const { current } = generation;
      const controller = new AbortController();
      abortRef.current = controller;
      const live = () => current === generation.current;
      const path = currentPath();
      // Usage reaches the configured analytics providers the same way page
      // feedback does: the question now, its outcome once the stream settles.
      // A reset mid-answer revokes the outcome along with the UI update.
      // Analytics keys on the raw pathname, like page feedback and the
      // providers' own pageviews, so the events join under a `base`; the
      // endpoint gets the base-stripped route for grounding. Providers receive
      // the question's length only: its text is free-form reader input (pasted
      // keys, error logs) that would breach their PII terms and their
      // per-value size caps, so it rides the `blume:track` event alone for a
      // site to bridge on its own terms.
      const { pathname } = window.location;
      const report = (
        event: "ask" | "ask_answer" | "ask_error",
        props: Record<string, number>
      ) =>
        track(
          event,
          { ...props, path: pathname, questionChars: trimmed.length },
          { question: trimmed }
        );
      report("ask", {});
      // A monotonic clock: the wall clock can jump mid-stream (NTP, sleep).
      const startedAt = performance.now();
      const outcome = (
        event: "ask_answer" | "ask_error",
        props: Record<string, number>
      ) =>
        report(event, {
          ...props,
          ms: Math.round(performance.now() - startedAt),
        });
      // The HTTP status once a response exists. `streamText` defers provider
      // errors to stream consumption, so a 200 can still break mid-flight;
      // that reports as a 200 error, not as "no response".
      let status = 0;
      const history: AskMessage[] = [
        ...messages,
        { content: trimmed, role: "user" },
      ];
      const assistant: AskMessage = { content: "", role: "assistant" };
      setMessages([...history, assistant]);
      setLoading(true);
      try {
        const response = await fetch(endpoint, {
          body: JSON.stringify({
            messages: history,
            page: { path },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        ({ status } = response);
        if (!response.ok) {
          // An error body (JSON, HTML error page) must not stream in as the
          // assistant's answer — only the route's own not-configured notice.
          const notice = await unavailableNotice(response).catch(() => null);
          if (live()) {
            outcome("ask_error", { status });
            assistant.content = notice ?? errorMessage;
            setMessages([...history, { ...assistant }]);
          }
          return;
        }
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        if (reader) {
          let done = false;
          while (!done && live()) {
            // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- sequential stream consumption; iterations are not independent
            const chunk = await reader.read();
            ({ done } = chunk);
            if (chunk.value && live()) {
              // Streaming mode: a multi-byte UTF-8 sequence split across
              // chunks must not flush as U+FFFD garbage.
              assistant.content += decoder.decode(chunk.value, {
                stream: true,
              });
              setMessages((currentMessages) => [
                ...currentMessages.slice(0, -1),
                { ...assistant },
              ]);
            }
          }
        }
        if (live()) {
          // A 200 with nothing in it (no body, an empty stream) is not an
          // answer. It is also how a provider failure after the 200 arrives
          // (a bad key, a rate limit, an unknown model): the route's text
          // stream carries only text, so the error ends it empty. Show the
          // error notice instead of leaving a pulsing blank bubble.
          if (assistant.content) {
            outcome("ask_answer", { chars: assistant.content.length });
          } else {
            outcome("ask_error", { status });
            assistant.content = errorMessage;
            setMessages([...history, { ...assistant }]);
          }
        }
      } catch {
        // A thrown fetch (offline, DNS failure, CORS) must not strand the
        // pre-appended empty assistant message as a stuck placeholder. A
        // reset's abort lands here too — the guard keeps it silent.
        if (live()) {
          outcome("ask_error", { status });
          assistant.content = errorMessage;
          setMessages([...history, { ...assistant }]);
        }
        // oxlint-disable-next-line react/todo -- React Compiler cannot lower try/finally; the hook stays manually memoized above
      } finally {
        if (live()) {
          setLoading(false);
        }
      }
    },
    [endpoint, errorMessage, loading, messages]
  );

  // Retained for the compiler-off opt-out path (`react: { compiler: false }`):
  // keeps a stable `reset` identity. With the compiler on it's redundant but inert.
  // oxlint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- see above
  const reset = useCallback(() => {
    generation.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    // The in-flight `ask`'s finally is now stale and won't clear this.
    setLoading(false);
  }, []);

  return { ask, loading, messages, reset };
};
