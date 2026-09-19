import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions } from "./shared.ts";
import { DEFAULT_CONTENT_GLOB, sharedSourceOptionsSchema } from "./shared.ts";

/** Options for {@link mdxRemote}. */
export interface MdxRemoteOptions extends SharedSourceOptions {
  /** Explicit list of source-relative file paths to fetch from `url`. */
  files?: string[];
  /** Enumerate a GitHub repo subtree via the git-trees API. */
  github?: {
    /** Repository owner (user or org). */
    owner: string;
    /** Subpath within the repo. Defaults to the repo root. */
    path?: string;
    /** Git ref (branch, tag, or SHA). Defaults to `main`. */
    ref?: string;
    /** Repository name. */
    repo: string;
  };
  /** Glob patterns applied to enumerated refs. Defaults to `["**\/*.{md,mdx}"]`. */
  include?: string[];
  /** Raw base URL, e.g. `https://raw.githubusercontent.com/acme/sdk/main/docs`. */
  url?: string;
}

export const mdxRemoteOptionsSchema = sharedSourceOptionsSchema.extend({
  files: z.array(z.string()).optional(),
  github: z
    .strictObject({
      owner: z.string(),
      path: z.string().default(""),
      ref: z.string().default("main"),
      repo: z.string(),
    })
    .optional(),
  include: z.array(z.string()).default([DEFAULT_CONTENT_GLOB]),
  url: z.string().optional(),
});

export type MdxRemoteAdapter = AdapterDescriptor<
  "mdx-remote",
  MdxRemoteOptions
>;

export const mdxRemoteAdapterSchema = adapterDescriptorSchema(
  "mdx-remote",
  mdxRemoteOptionsSchema
);

/**
 * Remote Markdown/MDX fetched over HTTP. Enumerate files explicitly against a
 * raw `url` base, or from a GitHub repo subtree via `github`. A private repo's
 * token comes from `GITHUB_TOKEN` — never inline it here.
 */
export const mdxRemote = (options: MdxRemoteOptions): MdxRemoteAdapter => ({
  kind: "mdx-remote",
  options,
  requiredSecrets: ["GITHUB_TOKEN"],
  runtimeDeps: [],
});
