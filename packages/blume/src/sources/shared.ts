import { z } from "zod";

/** The glob every content-reading adapter defaults `include` to. */
export const DEFAULT_CONTENT_GLOB = "**/*.{md,mdx}";

/**
 * Options every built-in content source shares. They ride on the descriptor
 * beside the adapter's own options, so an adapter declares only what is
 * specific to it.
 */
export interface SharedSourceOptions {
  /**
   * Opt-in dev polling interval (seconds) for a remote source; omit to fetch
   * once and freeze for the session. Local sources (`filesystem()`,
   * `obsidian()`) watch the filesystem instead and ignore it.
   */
  pollInterval?: number;
  /** Namespaces the source's routes under `/<prefix>/`. */
  prefix?: string;
}

/** The schema for {@link SharedSourceOptions}; each adapter extends it. */
export const sharedSourceOptionsSchema = z.strictObject({
  pollInterval: z.number().positive().optional(),
  prefix: z.string().optional(),
});
