import { z } from "zod";

import type { SearchAdapter } from "./types.ts";

/**
 * Connection details for a self-hosted or cloud Typesense node. The browser
 * queries the collection with the search-only `apiKey`; the build-time sync
 * recreates the collection with `TYPESENSE_ADMIN_API_KEY`, which never enters
 * the config.
 */
export interface TypesenseOptions {
  /** The search-only API key (public — it ships to the browser). */
  apiKey: string;
  collection: string;
  host: string;
  /** Defaults to 443. */
  port?: number;
  /** Defaults to `https`. */
  protocol?: "http" | "https";
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- mirrors the schema's `looseObject` (the drift guard requires it); extra options pass through to the client verbatim
  [option: string]: unknown;
}

export type TypesenseAdapter = SearchAdapter<
  "typesense",
  "hosted",
  TypesenseOptions
>;

export const typesenseOptionsSchema = z.looseObject({
  apiKey: z.string(),
  collection: z.string(),
  host: z.string(),
  port: z.number().int().positive().optional(),
  protocol: z.enum(["http", "https"]).optional(),
});

/**
 * Hosted search on Typesense. Each `blume build` drops and recreates the
 * collection so deleted or renamed pages don't linger as stale hits.
 */
export const typesense = (options: TypesenseOptions): TypesenseAdapter => ({
  kind: "typesense",
  mode: "hosted",
  options,
  requiredSecrets: [],
  runtimeDeps: ["typesense"],
});
