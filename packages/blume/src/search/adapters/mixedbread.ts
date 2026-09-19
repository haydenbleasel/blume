import { z } from "zod";

import type { SearchAdapter } from "./types.ts";

/** The Mixedbread store the generated `/api/search` endpoint queries. */
export interface MixedbreadOptions {
  storeId: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- mirrors the schema's `looseObject` (the drift guard requires it); extra options pass through to the endpoint verbatim
  [option: string]: unknown;
}

export type MixedbreadAdapter = SearchAdapter<
  "mixedbread",
  "server",
  MixedbreadOptions
>;

export const mixedbreadOptionsSchema = z.looseObject({
  storeId: z.string(),
});

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
