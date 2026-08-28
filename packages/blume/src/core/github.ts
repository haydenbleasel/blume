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
 */

import type { ResolvedConfig } from "./schema.ts";

/** The resolved `github` block, which the config leaves optional. */
export type GithubTarget = NonNullable<ResolvedConfig["github"]>;

const PUBLIC_API_URL = "https://api.github.com";
const PUBLIC_HOSTNAME = "github.com";
/** Enterprise Cloud with data residency: `<tenant>.ghe.com`. */
const DATA_RESIDENCY_SUFFIX = ".ghe.com";

/** Drop a trailing slash so joins never double up. */
const trimTrailingSlash = (value: string): string => value.replace(/\/+$/u, "");

/** `owner/repo` — the bare slug, with no origin attached. */
export const repoSlug = (github: GithubTarget): string =>
  `${github.owner}/${github.repo}`;

/** The repository's web URL, e.g. `https://github.com/acme/docs`. */
export const repoUrl = (github: GithubTarget): string =>
  `${trimTrailingSlash(github.host)}/${repoSlug(github)}`;

/** The base every edit link extends with a repo-relative path. */
export const editBaseUrl = (github: GithubTarget): string =>
  `${repoUrl(github)}/edit/${github.branch}`;

/**
 * The REST API base for `host`. An explicit `api` always wins; otherwise
 * github.com maps to api.github.com, a data-residency tenant to its `api.`
 * subdomain, and anything else is treated as Enterprise Server (`/api/v3`).
 */
export const apiUrl = (github: GithubTarget): string => {
  if (github.api) {
    return trimTrailingSlash(github.api);
  }
  const host = trimTrailingSlash(github.host);
  const { hostname, protocol } = new URL(host);
  if (hostname === PUBLIC_HOSTNAME) {
    return PUBLIC_API_URL;
  }
  if (hostname.endsWith(DATA_RESIDENCY_SUFFIX)) {
    return `${protocol}//api.${hostname}`;
  }
  return `${host}/api/v3`;
};
