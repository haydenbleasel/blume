import { z } from "zod";

import type { SearchAdapter } from "./types.ts";

/**
 * Public Orama Cloud credentials. The browser queries `endpoint` with the
 * public `apiKey`; the build-time sync pushes records to `indexId` with
 * `ORAMA_PRIVATE_API_KEY`, which never enters the config.
 */
export interface OramaCloudOptions {
  /** The public API key (it ships to the browser). */
  apiKey: string;
  endpoint: string;
  /** Index id used by the build-time sync; omit to skip syncing. */
  indexId?: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- mirrors the schema's `looseObject` (the drift guard requires it); extra options pass through to the client verbatim
  [option: string]: unknown;
}

export type OramaCloudAdapter = SearchAdapter<
  "orama-cloud",
  "hosted",
  OramaCloudOptions
>;

export const oramaCloudOptionsSchema = z.looseObject({
  apiKey: z.string(),
  endpoint: z.string(),
  indexId: z.string().optional(),
});

/**
 * Hosted Orama. The browser queries your index endpoint directly; each
 * `blume build` snapshots the records into the index and deploys it.
 */
export const oramaCloud = (options: OramaCloudOptions): OramaCloudAdapter => ({
  kind: "orama-cloud",
  mode: "hosted",
  options,
  requiredSecrets: [],
  runtimeDeps: ["@oramacloud/client"],
});
