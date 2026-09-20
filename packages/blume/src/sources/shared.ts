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

/** Field paths mapping a CMS document onto Blume meta + body. */
export interface SourceFieldMap {
  /** Field holding the renderable body (rich text, or a Markdown string). */
  body?: string;
  /** Field holding the page description. */
  description?: string;
  /** Field holding the last-modified date. */
  lastModified?: string;
  /** Field holding the page slug. */
  slug?: string;
  /** Field holding the page title. */
  title?: string;
}

/** The schema for {@link SourceFieldMap}. */
export const sourceFieldMapSchema = z.strictObject({
  body: z.string().optional(),
  description: z.string().optional(),
  lastModified: z.string().optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
});

/** Extra query parameters a REST-backed adapter appends to its request. */
export const queryParamsSchema = z.record(z.string(), z.string());
