import { z } from "zod";

import type { JsonValue } from "../../core/adapter.ts";
import type { SearchAdapter } from "./types.ts";

/**
 * The Mixedbread store the generated `/api/search` endpoint queries, plus any
 * other option, forwarded to the endpoint verbatim. JSON values only.
 */
export interface MixedbreadOptions {
  storeId: string;
  [option: string]: JsonValue;
}

export type MixedbreadAdapter = SearchAdapter<
  "mixedbread",
  "server",
  MixedbreadOptions
>;

export const mixedbreadOptionsSchema = z
  .object({
    storeId: z.string(),
  })
  .catchall(z.json());

/**
 * Semantic search on Mixedbread. Queries go through a generated `/api/search`
 * endpoint that holds `MIXEDBREAD_API_KEY`, so the adapter requires server
 * output. Content is synced to the store out-of-band with the `mxbai` CLI,
 * not by the build.
 */
export const mixedbread = (options: MixedbreadOptions): MixedbreadAdapter => ({
  kind: "mixedbread",
  mode: "server",
  options,
  requiredSecrets: ["MIXEDBREAD_API_KEY"],
  runtimeDeps: ["@mixedbread/sdk"],
});
