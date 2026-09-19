import { z } from "zod";

import type { KeylessSearchOptions, SearchAdapter } from "./types.ts";

/** Orama needs no options; any extra keys ride along to the client verbatim. */
export type OramaOptions = KeylessSearchOptions;

export type OramaAdapter = SearchAdapter<"orama", "static", OramaOptions>;

export const oramaOptionsSchema = z.looseObject({});

/**
 * Blume's default search: a JSON index built from the source files, served
 * at `/blume-search.json` and queried in the browser. Keyless, and live in
 * `blume dev`. The tokenizer follows `i18n.defaultLocale`, so non-Latin
 * scripts are word-segmented.
 */
export const orama = (options: OramaOptions = {}): OramaAdapter => ({
  kind: "orama",
  mode: "static",
  options,
  requiredSecrets: [],
  runtimeDeps: ["@orama/orama"],
});
