import { highlight, SEARCH_LIMIT } from "./types.ts";
import type { SearchClientOptions, SearchFn, SearchHit } from "./types.ts";

/**
 * How long a typed query waits for the reader to stop typing before it's
 * sent, in milliseconds. The dialog searches on every keystroke, and each
 * request counts toward the endpoint's `rateLimit`.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/** Resolve after `ms`, or reject with the abort reason once `signal` aborts. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- adapt setTimeout and the abort event
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });

/**
 * Server-proxied search (Mixedbread): POST the query to a generated endpoint
 * that holds the secret key and talks to the service. The returned hits carry
 * service-derived text and the dialog injects title/excerpt as HTML, so both
 * are escaped (and query matches marked) here, like every other provider.
 * A failed request rejects, as a hosted provider's does, so the dialog shows
 * its error rather than an empty "no results".
 *
 * With `typing` (the search dialog), a query waits {@link SEARCH_DEBOUNCE_MS}
 * before it's sent, and a newer one supersedes it: the earlier call's wait or
 * request is aborted and it rejects with an `AbortError`. Typing a word then
 * costs one request rather than one per letter, and a slow earlier response
 * can't land after a later one. Without it, every call is sent at once.
 */
export const createSearch = (
  opts: { api: string } & SearchClientOptions
): SearchFn => {
  let pending: AbortController | undefined;
  return async (query) => {
    let signal: AbortSignal | undefined;
    if (opts.typing) {
      pending?.abort();
      pending = new AbortController();
      ({ signal } = pending);
      await pause(SEARCH_DEBOUNCE_MS, signal);
    }
    const response = await fetch(opts.api, {
      body: JSON.stringify({ query }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Search failed: ${opts.api} answered ${response.status}.`
      );
    }
    // SAFETY: the endpoint is Blume-generated (`search-endpoint` template) and
    // responds with the SearchHit list it built; title/excerpt are still
    // escaped below before the dialog injects them as HTML.
    const records = (await response.json()) as SearchHit[];
    const hits = records.slice(0, SEARCH_LIMIT).map((hit) => ({
      ...hit,
      excerpt: highlight(hit.excerpt, query),
      title: highlight(hit.title, query),
    }));
    return { hits, sections: [] };
  };
};
