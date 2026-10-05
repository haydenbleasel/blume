/**
 * Search analytics: what readers search for, what they find, and what they
 * open, sent through the configured analytics adapters (`track`).
 *
 * The dialog searches on every keystroke, so a query is only recorded once it
 * settles: a second without typing, or the reader picking a result or closing
 * the dialog. Each settled query is one `search` event with the number of
 * results, so a dashboard can list the queries that found nothing. Picking a
 * result is a `search_select` event with its position, for click-through. The
 * same query settling twice in a row (a filter toggled back and forth) counts
 * once.
 *
 * With `search.analytics.queries: false`, providers get each query's length
 * (`queryChars`) instead of its text, and the text rides only the
 * `blume:track` DOM event, the way the assistant reports questions.
 */
import type { TrackProps } from "../analytics-client.ts";

/** The longest query sent: past this it's rarely a search term. */
export const MAX_QUERY_CHARS = 100;

/** How long a query sits untouched before it counts as settled. */
export const SETTLE_MS = 1000;

/**
 * Sends one analytics event; `local` rides only the `blume:track` DOM event
 * (see `track`).
 */
export type SendEvent = (
  event: string,
  props: TrackProps,
  local?: TrackProps
) => void;

/** The timer a tracker waits on; injectable for tests. */
export interface SettleTimer {
  cancel: (handle: number) => void;
  start: (callback: () => void, ms: number) => number;
}

/** How a tracker reports. */
export interface SearchTrackerOptions {
  /** Whether providers receive each query's text (`search.analytics.queries`). */
  queries?: boolean;
  /** The timer a query waits on to settle; injectable for tests. */
  timer?: SettleTimer;
}

/** What the dialog tells the tracker. */
export interface SearchTracker {
  /** The dialog closed; record the query it was showing. */
  closed: () => void;
  /** The reader picked result `position` (1-based) for `query`. */
  selected: (query: string, position: number, url: string) => void;
  /** Results for `query` are on screen. */
  settled: (query: string, results: number) => void;
}

/** A query and how many results it found. */
interface PendingSearch {
  query: string;
  results: number;
}

const browserTimer: SettleTimer = {
  cancel: (handle) => clearTimeout(handle),
  start: (callback, ms) => Number(setTimeout(callback, ms)),
};

/** A tracker for one search dialog. */
export const createSearchTracker = (
  send: SendEvent,
  { queries = true, timer = browserTimer }: SearchTrackerOptions = {}
): SearchTracker => {
  let pending: PendingSearch | undefined;
  let handle: number | undefined;
  let last: string | undefined;

  // Providers get the query's text, or only its length, in which case the
  // text goes to the `blume:track` DOM event alone.
  const report = (event: string, props: TrackProps, query: string): void => {
    if (queries) {
      send(event, { ...props, query });
    } else {
      send(event, { ...props, queryChars: query.length }, { query });
    }
  };

  const flush = (): void => {
    if (handle !== undefined) {
      timer.cancel(handle);
      handle = undefined;
    }
    if (pending && pending.query !== last) {
      report(
        "search",
        { path: location.pathname, results: pending.results },
        pending.query
      );
      last = pending.query;
    }
    pending = undefined;
  };

  return {
    closed: () => {
      flush();
      last = undefined;
    },
    selected: (query, position, url) => {
      flush();
      report(
        "search_select",
        { path: location.pathname, position, url },
        query.slice(0, MAX_QUERY_CHARS)
      );
    },
    settled: (query, results) => {
      if (handle !== undefined) {
        timer.cancel(handle);
      }
      pending = { query: query.slice(0, MAX_QUERY_CHARS), results };
      handle = timer.start(flush, SETTLE_MS);
    },
  };
};
