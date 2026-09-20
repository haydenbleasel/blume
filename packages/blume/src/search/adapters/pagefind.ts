import { z } from "zod";

import type { KeylessSearchOptions, SearchAdapter } from "./types.ts";

/** Pagefind takes no options; unknown keys fail config validation. */
export type PagefindOptions = KeylessSearchOptions;

export type PagefindAdapter = SearchAdapter<
  "pagefind",
  "pagefind",
  PagefindOptions
>;

export const pagefindOptionsSchema = z.strictObject({});

/**
 * Pagefind indexes the built HTML after `blume build` and loads the index in
 * shards on demand, so the initial payload stays small on very large sites.
 * The index only exists in the production build, not in `blume dev`.
 */
export const pagefind = (options: PagefindOptions = {}): PagefindAdapter => ({
  kind: "pagefind",
  mode: "pagefind",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});
