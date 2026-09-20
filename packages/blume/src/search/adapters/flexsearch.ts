import { z } from "zod";

import type { KeylessSearchOptions, SearchAdapter } from "./types.ts";

/** FlexSearch takes no options; unknown keys fail config validation. */
export type FlexsearchOptions = KeylessSearchOptions;

export type FlexsearchAdapter = SearchAdapter<
  "flexsearch",
  "static",
  FlexsearchOptions
>;

export const flexsearchOptionsSchema = z.strictObject({});

/**
 * A second keyless, client-side engine. It loads the same `/blume-search.json`
 * index Orama ships and builds a FlexSearch document index in the browser.
 * No locale-aware tokenizer, so prefer Orama for non-Latin scripts.
 */
export const flexsearch = (
  options: FlexsearchOptions = {}
): FlexsearchAdapter => ({
  kind: "flexsearch",
  mode: "static",
  options,
  requiredSecrets: [],
  runtimeDeps: ["flexsearch"],
});
