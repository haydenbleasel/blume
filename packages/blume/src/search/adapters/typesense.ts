import { z } from "zod";

import type { JsonValue } from "../../core/adapter.ts";
import type { SearchAdapter } from "./types.ts";

/**
 * Connection details for a self-hosted or cloud Typesense node. The browser
 * queries the collection with the search-only `apiKey`; the build-time sync
 * recreates the collection with `TYPESENSE_ADMIN_API_KEY`, which never enters
 * the config.
 */
export interface TypesenseNamedOptions {
  /** The search-only API key (public — it ships to the browser). */
  apiKey: string;
  collection: string;
  host: string;
  /** Defaults to 443. */
  port?: number;
  /** Defaults to `https`. */
  protocol?: "http" | "https";
}

/**
 * Options for {@link typesense}: the named options plus any other client
 * option, forwarded to the browser verbatim. JSON values only.
 */
export type TypesenseOptions = TypesenseNamedOptions & {
  [option: string]: JsonValue;
};

export type TypesenseAdapter = SearchAdapter<
  "typesense",
  "hosted",
  TypesenseOptions
>;

export const typesenseOptionsSchema = z
  .object({
    apiKey: z.string(),
    collection: z.string(),
    host: z.string(),
    port: z.number().int().positive().optional(),
    protocol: z.enum(["http", "https"]).optional(),
  })
  .catchall(z.json());

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
