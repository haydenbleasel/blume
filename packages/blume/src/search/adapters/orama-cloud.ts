import { z } from "zod";

import type { JsonValue } from "../../core/adapter.ts";
import type { SearchAdapter } from "./types.ts";

/**
 * Public Orama Cloud credentials. The browser queries `endpoint` with the
 * public `apiKey`; the build-time sync pushes records to `indexId` with
 * `ORAMA_PRIVATE_API_KEY`, which never enters the config.
 */
export interface OramaCloudNamedOptions {
  /** The public API key (it ships to the browser). */
  apiKey: string;
  endpoint: string;
  /** Index id used by the build-time sync; omit to skip syncing. */
  indexId?: string;
}

/**
 * Options for {@link oramaCloud}: the named options plus any other client
 * option, forwarded to the browser verbatim. JSON values only.
 */
export type OramaCloudOptions = OramaCloudNamedOptions & {
  [option: string]: JsonValue;
};

export type OramaCloudAdapter = SearchAdapter<
  "orama-cloud",
  "hosted",
  OramaCloudOptions
>;

export const oramaCloudOptionsSchema = z
  .object({
    apiKey: z.string(),
    endpoint: z.string(),
    indexId: z.string().optional(),
  })
  .catchall(z.json());

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
