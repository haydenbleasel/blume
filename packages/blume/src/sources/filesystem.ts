import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions } from "./shared.ts";
import { DEFAULT_CONTENT_GLOB, sharedSourceOptionsSchema } from "./shared.ts";

/** What `include` defaults to: every Markdown/MDX file under the root. */
export const DEFAULT_CONTENT_INCLUDE = [DEFAULT_CONTENT_GLOB];
/** What `exclude` defaults to: underscore- and dot-prefixed paths. */
export const DEFAULT_CONTENT_EXCLUDE = ["**/_*", "**/.*"];

/** Options for {@link filesystem}. */
export interface FilesystemOptions extends SharedSourceOptions {
  /** Glob patterns to ignore. Defaults to `["**\/_*", "**\/.*"]`. */
  exclude?: string[];
  /** Glob patterns to include. Defaults to `["**\/*.{md,mdx}"]`. */
  include?: string[];
  /** Directory to read from, relative to the project root. Defaults to `docs`. */
  root?: string;
}

export const filesystemOptionsSchema = sharedSourceOptionsSchema.extend({
  exclude: z.array(z.string()).default(DEFAULT_CONTENT_EXCLUDE),
  include: z.array(z.string()).default(DEFAULT_CONTENT_INCLUDE),
  root: z.string().default("docs"),
});

export type FilesystemAdapter = AdapterDescriptor<
  "filesystem",
  FilesystemOptions
>;

export const filesystemAdapterSchema = adapterDescriptorSchema(
  "filesystem",
  filesystemOptionsSchema
);

/**
 * Local Markdown/MDX read from a directory. The zero-config default: with no
 * `content.sources`, the top-level `content.root`/`include`/`exclude` desugar
 * to exactly one of these.
 */
export const filesystem = (
  options: FilesystemOptions = {}
): FilesystemAdapter => ({
  kind: "filesystem",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});
