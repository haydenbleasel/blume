import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { join } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import type { Diagnostic } from "../types.ts";
import type { SourceEntry, SourceLoadResult } from "./types.ts";

/**
 * Small, stable content hash for cache/HMR bookkeeping — and for staged asset
 * *filenames* (see sources/assets.ts and content-assets.ts), where a collision
 * silently serves the wrong file. 64 bits of SHA-256 keeps those names
 * collision-safe at any realistic asset count; the old 31-bit DJB2 hash had a
 * ~46k-item birthday bound.
 */
export const hashText = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A stable digest of a source's entries, for change detection while polling. */
export const entriesDigest = (entries: SourceEntry[]): string =>
  hashText(
    entries
      .map((entry) => `${entry.ref}:${entry.hash ?? hashText(entry.body.text)}`)
      .join("|")
  );

/**
 * Build an opt-in polling watcher for a remote source: re-`load()` on an
 * interval and fire `onChange` only when the entry digest changes, so a remote
 * source can hot-reload in dev without refetching the world on every keystroke.
 *
 * `load` must fetch fresh (bypassing the cache-first dev path) — polling the
 * cache-first loader would serve the identical snapshot on every tick and
 * never observe a remote change. `seed` (the source's regular, cache-first
 * loader) establishes the baseline digest from what dev actually served, so a
 * remote change landing before the first tick still fires.
 */
export const pollingWatch =
  (
    load: () => Promise<SourceLoadResult>,
    intervalSeconds: number,
    seed?: () => Promise<SourceLoadResult>
  ): ((onChange: () => void) => () => void) =>
  (onChange) => {
    let last = "";
    if (seed) {
      const seedBaseline = async (): Promise<void> => {
        try {
          const { entries } = await seed();
          last ||= entriesDigest(entries);
        } catch {
          // Fall back to first-tick seeding.
        }
      };
      void seedBaseline();
    }
    const tick = async (): Promise<void> => {
      try {
        const { entries } = await load();
        const next = entriesDigest(entries);
        if (last && next !== last) {
          onChange();
        }
        last = next;
      } catch {
        // Ignore transient poll failures; the cache keeps serving last-known-good.
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, intervalSeconds * 1000);
    return () => clearInterval(timer);
  };

/** A per-source snapshot of the last successful fetch, for offline tolerance. */
export interface SnapshotCache {
  read: () => Promise<SourceEntry[]>;
  write: (entries: SourceEntry[]) => Promise<void>;
}

/** Build a JSON snapshot cache under `<cacheDir>/entries.json`. */
export const snapshotCache = (cacheDir: string): SnapshotCache => {
  const file = join(cacheDir, "entries.json");
  return {
    read: async () => {
      try {
        // SAFETY: the snapshot file is only ever written by `write` below, from
        // a `SourceEntry[]` via JSON.stringify; a corrupt file lands in the
        // catch and reads as empty.
        return JSON.parse(await readFile(file, "utf-8")) as SourceEntry[];
      } catch {
        return [];
      }
    },
    write: async (entries) => {
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(file, `${JSON.stringify(entries)}\n`, "utf-8");
      } catch {
        // Cache is best-effort; a write failure must not fail the build.
      }
    },
  };
};

/**
 * Run a remote `fetchEntries`, caching the result. When `refresh` is false and a
 * snapshot exists, serve it without fetching (cache-first dev). On fetch failure,
 * serve the last-known-good snapshot with a warning so a CMS/network outage
 * doesn't fail the build; if there is no snapshot either, surface a hard error.
 */
export const loadWithCache = async (
  name: string,
  cache: SnapshotCache,
  fetchEntries: () => Promise<SourceEntry[]>,
  refresh = true
): Promise<SourceLoadResult> => {
  if (!refresh) {
    const cached = await cache.read();
    if (cached.length > 0) {
      return { diagnostics: [], entries: cached };
    }
  }
  try {
    const entries = await fetchEntries();
    await cache.write(entries);
    return { diagnostics: [], entries };
  } catch (error) {
    const fallback = await cache.read();
    if (fallback.length > 0) {
      // SAFETY: everything thrown on this path is an Error — fetch rejects
      // with a TypeError and the source adapters throw Error instances.
      const diagnostic: Diagnostic = {
        code: "BLUME_SOURCE_OFFLINE",
        message: `Source "${name}" could not be fetched (${(error as Error).message}); served ${fallback.length} cached entries.`,
        severity: "warning",
      };
      return { diagnostics: [diagnostic], entries: fallback };
    }
    // SAFETY: same invariant as above — `fetchEntries` failures are Errors.
    throw new BlumeError({
      code: "BLUME_SOURCE_FETCH_FAILED",
      message: `Source "${name}" failed to load and no cache is available: ${(error as Error).message}`,
      severity: "error",
    });
  }
};
