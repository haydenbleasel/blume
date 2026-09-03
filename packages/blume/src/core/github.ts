/**
 * Repository URL derivation for `config.github`.
 *
 * Every repo-derived link — the header mark, per-page edit links, the agent
 * manifest's `repository` — is built from `host`, which defaults to github.com
 * but accepts a GitHub Enterprise origin so self-hosted and data-resident
 * installations get working links instead of ones pointing at the public site.
 *
 * The REST base is derived from the host unless `api` is set explicitly, since
 * the two Enterprise flavors expose it differently: Enterprise Cloud with data
 * residency serves it from an `api.` subdomain of the same host, Enterprise
 * Server from `/api/v3` on the host itself.
 *
 * `host` arrives as a bare origin and `api` as an origin plus path, both with
 * no trailing slash — the config schema normalizes them — so nothing here
 * re-trims user input.
 */

import type { ResolvedConfig } from "./schema.ts";

/** The resolved `github` block, which the config leaves optional. */
export type GithubTarget = NonNullable<ResolvedConfig["github"]>;

/** The public instance every `host` defaults to. */
export const PUBLIC_HOST_URL = "https://github.com";
/** The public instance's REST base. */
export const PUBLIC_API_URL = "https://api.github.com";
const PUBLIC_HOSTNAME = "github.com";
/** Enterprise Cloud with data residency: `<tenant>.ghe.com`. */
const DATA_RESIDENCY_SUFFIX = ".ghe.com";

/** `owner/repo` — the bare slug, with no origin attached. */
const repoSlug = (github: Pick<GithubTarget, "owner" | "repo">): string =>
  `${github.owner}/${github.repo}`;

/** The repository's web URL, e.g. `https://github.com/acme/docs`. */
export const repoUrl = (
  github: Pick<GithubTarget, "host" | "owner" | "repo">
): string => `${github.host}/${repoSlug(github)}`;

/** The base every edit link extends with a repo-relative path. */
export const editBaseUrl = (
  github: Pick<GithubTarget, "branch" | "host" | "owner" | "repo">
): string => `${repoUrl(github)}/edit/${github.branch}`;

/**
 * The REST API base for `host`. An explicit `api` always wins; otherwise
 * github.com (and any subdomain of it, `www.` say) maps to api.github.com, a
 * data-residency tenant to its `api.` subdomain, and anything else is treated
 * as Enterprise Server (`/api/v3`).
 */
export const apiUrl = (github: Pick<GithubTarget, "api" | "host">): string => {
  if (github.api) {
    return github.api;
  }
  const url = new URL(github.host);
  const { hostname } = url;
  if (
    hostname === PUBLIC_HOSTNAME ||
    hostname.endsWith(`.${PUBLIC_HOSTNAME}`)
  ) {
    return PUBLIC_API_URL;
  }
  if (hostname.endsWith(DATA_RESIDENCY_SUFFIX)) {
    // Rebuilt through the URL so a non-default port survives alongside the
    // subdomain rather than being dropped from the API base alone.
    url.hostname = `api.${hostname}`;
    return url.origin;
  }
  return `${github.host}/api/v3`;
};
