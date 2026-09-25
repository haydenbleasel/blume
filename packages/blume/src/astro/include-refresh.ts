import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Loader, LoaderContext } from "astro/loaders";
import { resolve } from "pathe";

/** One stored entry, as the scoped store enumerates it. */
type StoreEntry = ReturnType<LoaderContext["store"]["entries"]>[number][1];

/**
 * Content-layer half of `<include>` freshness (the Vite half is
 * `includeHmrPlugin`). Plain `.md` pages are rendered at content-sync time by
 * Astro's glob loader and stored as `rendered.html`, gated by a digest of the
 * page file alone — so an edit to an included partial would keep serving the
 * page's stale stored HTML (in dev after the partial edit, and in a
 * warm-`.blume` production build reusing the previous build's store).
 *
 * Before each load, the wrapper walks the stored entries that splice partials
 * (per the generated partial → includers graph) and compares a digest of
 * their partials' current contents against the one recorded in the
 * collection's meta store on the previous load. A mismatch evicts the entry:
 * with nothing stored under its id, the glob loader parses and renders the
 * page afresh on the load that follows, exactly as it would a new file. Both
 * halves use the loader context Astro documents — `store.entries` /
 * `store.delete` and the `meta` key-value store — and include-free pages (the
 * overwhelmingly common case) are never touched.
 */

/** Meta-store key holding the recorded partials digest of an includer. */
const stateKey = (id: string): string => `blume:include-state:${id}`;

/**
 * The generated include graph: partial → including pages, absolute in the
 * hidden runtime and relative to the project root in an ejected app.
 */
type IncludeGraph = Record<string, string[]>;

/**
 * Read the include graph, empty when the file isn't there yet (first run) or
 * can't be parsed (a hand-edit).
 */
const readGraph = (graphPath: string): IncludeGraph => {
  try {
    // SAFETY: `generateRuntime`/`eject` are the file's only writers and
    // serialize exactly this shape; a malformed hand-edit throws into the
    // fallback below.
    return JSON.parse(readFileSync(graphPath, "utf-8")) as IncludeGraph;
  } catch {
    return {};
  }
};

/**
 * Invert the graph: absolute including page → its absolute partials, sorted.
 * Each path resolves against the Astro root, which leaves the hidden runtime's
 * absolute paths as they are.
 */
const partialsByPage = (
  graph: IncludeGraph,
  root: string
): Map<string, string[]> => {
  const byPage = new Map<string, string[]>();
  for (const [partial, pages] of Object.entries(graph)) {
    for (const page of pages) {
      const abs = resolve(root, page);
      const partials = byPage.get(abs) ?? [];
      partials.push(resolve(root, partial));
      byPage.set(abs, partials);
    }
  }
  for (const partials of byPage.values()) {
    partials.sort();
  }
  return byPage;
};

/**
 * Digest the current contents of a page's partials. A partial that fails to
 * read contributes a marker instead, so a deleted partial still changes the
 * digest and the page re-renders (to whatever the include plugin does with a
 * missing target).
 */
const partialsDigest = (
  context: LoaderContext,
  partials: readonly string[]
): string =>
  context.generateDigest(
    partials
      .map((partial) => {
        try {
          return readFileSync(partial, "utf-8");
        } catch {
          return `missing:${partial}`;
        }
      })
      .join(" ")
  );

/**
 * Evict one stored entry when its partials changed since the digest recorded
 * on the previous load (or when none was recorded — a store carried over from
 * before the graph knew the page). Returns whether it was evicted.
 */
const evictIfStale = (
  context: LoaderContext,
  byPage: ReadonlyMap<string, readonly string[]>,
  root: string,
  id: string,
  entry: StoreEntry
): boolean => {
  if (entry.filePath === undefined) {
    return false;
  }
  const partials = byPage.get(resolve(root, entry.filePath));
  if (!partials) {
    return false;
  }
  const state = partialsDigest(context, partials);
  const key = stateKey(id);
  if (context.meta.get(key) === state) {
    return false;
  }
  context.store.delete(id);
  context.meta.set(key, state);
  return true;
};

/**
 * Evict every stored include-bearing entry whose partials changed since the
 * previous load, so the loader that runs next re-renders them. Returns the
 * evicted ids (for tests and diagnostics).
 */
export const evictStaleIncluders = (
  context: LoaderContext,
  graphPath: string
): string[] => {
  const root = fileURLToPath(context.config.root);
  const byPage = partialsByPage(readGraph(graphPath), root);
  if (byPage.size === 0) {
    return [];
  }
  const evicted: string[] = [];
  for (const [id, entry] of context.store.entries()) {
    if (evictIfStale(context, byPage, root, id, entry)) {
      evicted.push(id);
    }
  }
  return evicted;
};

/**
 * Wrap a content-collection loader so include-bearing entries re-render when
 * their partials change (see module comment). The generated
 * `content.config.ts` (and its ejected copy) wraps the docs collection's
 * `glob()` with this; `graphPath` is the same `generated/includes.json` the
 * `includeHmrPlugin` reads.
 */
export const withIncludeRefresh = (
  inner: Loader,
  graphPath: string
): Loader => ({
  ...inner,
  load: (context) => {
    evictStaleIncluders(context, graphPath);
    return inner.load(context);
  },
});
