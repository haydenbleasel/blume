import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { SharedSourceOptions } from "./shared.ts";
import { sharedSourceOptionsSchema } from "./shared.ts";

/** Options for {@link githubReleases}. */
export interface GithubReleasesOptions extends SharedSourceOptions {
  /**
   * The GitHub REST API base URL. Defaults to `https://api.github.com`; a
   * GitHub Enterprise Server's is `https://<host>/api/v3`.
   */
  baseUrl?: string;
  /** Include draft releases, tagged `Draft` (needs a token with repo write access). */
  drafts?: boolean;
  /** Cap the number of releases materialized, newest-first. Defaults to 100. */
  limit?: number;
  /**
   * Keep release pages out of search engines' index: `true` for every one,
   * or `{ minWords }` for those whose notes have fewer words of prose
   * (headings, code, and changesets' leading commit hashes don't count). A
   * noindexed release still renders and stays in the `/changelog` timeline
   * and its feed, but drops out of the sitemap, `llms.txt`, and structured
   * data, as any `noindex` page does.
   */
  noindex?: GithubReleasesNoindex;
  /** Repository owner (user or org). */
  owner: string;
  /** Include prereleases. */
  prereleases?: boolean;
  /** Repository name. */
  repo: string;
}

/** {@link GithubReleasesOptions.noindex}. */
export type GithubReleasesNoindex = boolean | { minWords: number };

export const githubReleasesOptionsSchema = sharedSourceOptionsSchema.extend({
  baseUrl: z.string().optional(),
  drafts: z.boolean().optional(),
  limit: z.number().positive().optional(),
  noindex: z
    .union([
      z.boolean(),
      z.strictObject({ minWords: z.number().int().positive() }),
    ])
    .optional(),
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
