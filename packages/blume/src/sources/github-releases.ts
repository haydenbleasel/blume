import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions } from "./shared.ts";
import { sharedSourceOptionsSchema } from "./shared.ts";

/** Options for {@link githubReleases}. */
export interface GithubReleasesOptions extends SharedSourceOptions {
  /** Include draft releases (needs a token with repo write access). */
  drafts?: boolean;
  /** Cap the number of releases materialized, newest-first. Defaults to 100. */
  limit?: number;
  /** Repository owner (user or org). */
  owner: string;
  /** Include prereleases. */
  prereleases?: boolean;
  /** Repository name. */
  repo: string;
}

export const githubReleasesOptionsSchema = sharedSourceOptionsSchema.extend({
  drafts: z.boolean().optional(),
  limit: z.number().positive().optional(),
  owner: z.string(),
  prereleases: z.boolean().optional(),
  repo: z.string(),
});

export type GithubReleasesAdapter = AdapterDescriptor<
  "github-releases",
  GithubReleasesOptions
>;

export const githubReleasesAdapterSchema = adapterDescriptorSchema(
  "github-releases",
  githubReleasesOptionsSchema
);

/**
 * A repo's GitHub Releases, materialized as `type: changelog` entries — release
 * notes become the changelog with no files to maintain. A private repo reads a
 * token from `GITHUB_TOKEN`; it is never inlined here.
 */
export const githubReleases = (
  options: GithubReleasesOptions
): GithubReleasesAdapter => ({
  kind: "github-releases",
  options,
  requiredSecrets: ["GITHUB_TOKEN"],
  runtimeDeps: [],
});
