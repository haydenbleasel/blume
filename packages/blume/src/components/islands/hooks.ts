import { useCallback, useEffect, useRef, useState } from "react";

import type { BlumeClientData } from "../../core/data.ts";
import type { SearchFn, SearchResult } from "../layout/search/types.ts";
import { joinBase, stripBase } from "./base-path.ts";

/**
 * React hooks for Blume islands.
 *
 * Islands hydrate independently (there's no shared React root spanning them), so
 * project data can't come through context. Instead the layout serializes a small
 * snapshot into a `<script type="application/json" id="blume-client-data">` tag,
 * and {@link useBlume}/{@link usePage} read it after mount. {@link useSearch} and
 * {@link useAskAI} wrap the generated search client and the Ask AI endpoint.
 *
 * Import them from `blume/hooks`:
 *
 * ```tsx
 * import { useBlume, usePage } from "blume/hooks";
 * ```
 */

export type { BlumeClientData } from "../../core/data.ts";

let cachedData: BlumeClientData | null = null;

/** Read + parse the injected snapshot (memoized); null on the server. */
const readClientData = (): BlumeClientData | null => {
  if (cachedData) {
    return cachedData;
  }
  // `document` is undeclared on the server; probing `globalThis` avoids both
  // the bare-reference ReferenceError and a `typeof` sniff.
  if (!("document" in globalThis)) {
    return null;
  }
  const element = document.querySelector("#blume-client-data");
  if (!element?.textContent) {
    return null;
  }
  try {
    // SAFETY: the layout serialized this script tag's JSON from the same
    // `BlumeClientData` snapshot this reads back.
    cachedData = JSON.parse(element.textContent) as BlumeClientData;
    return cachedData;
  } catch {
    return null;
  }
};

/**
 * Read the injected snapshot after mount. `null` on the server and on the first
 * client render (so hydration matches), then the data once mounted.
 */
const useClientData = (): BlumeClientData | null => {
  const [data, setData] = useState<BlumeClientData | null>(null);
  // Intentional post-mount hydration guard: `null` on the server and first
  // client render so hydration matches, then the snapshot once mounted. The
  // extra render is required; do not seed the initial value from the DOM.
  // oxlint-disable-next-line react/react-compiler, react/set-state-in-effect, react-doctor/no-initialize-state -- deliberate SSR hydration guard
  useEffect(() => setData(readClientData()), []);
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

/** A single Ask AI chat message. */
export interface AskMessage {
  content: string;
  role: "assistant" | "user";
}

/** State + actions returned by {@link useAskAI}. */
export interface UseAskAI {
  ask: (question: string) => Promise<void>;
  loading: boolean;
  messages: AskMessage[];
  reset: () => void;
}

const DEFAULT_ASK_ENDPOINT = joinBase(import.meta.env.BASE_URL, "api/ask");

export interface UseAskAIOptions {
  /** Existing Ask AI endpoint; defaults to Blume's generated `/api/ask`. */
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

/** The current route with the deployment base stripped, for page grounding. */
const currentPath = (): string =>
  stripBase(import.meta.env.BASE_URL, window.location.pathname);

/**
 * Stream answers from the Ask AI endpoint. Mirrors the built-in Ask AI island so
 * a custom chat UI shares the same grounded, page-aware backend.
 */
export const useAskAI = (options: UseAskAIOptions = {}): UseAskAI => {
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
  const ask = useCallback<UseAskAI["ask"]>(
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
            page: { path: currentPath() },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) {
          // An error body (JSON, HTML error page) must not stream in as the
          // assistant's answer.
          if (live()) {
            assistant.content = errorMessage;
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
      } catch {
        // A thrown fetch (offline, DNS failure, CORS) must not strand the
        // pre-appended empty assistant message as a stuck placeholder. A
        // reset's abort lands here too — the guard keeps it silent.
        if (live()) {
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
