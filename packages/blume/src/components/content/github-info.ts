/**
 * Build-time GitHub repository lookup for `<GithubInfo>`.
 *
 * Fetches a repo's star and fork counts (plus description) from the GitHub REST
 * API. Results are cached per repo for the lifetime of the build, and any
 * failure — network error, rate limit, missing repo — resolves to `null` rather
 * than throwing, so a card never breaks the build when the API is unreachable.
 */

export interface RepositoryInfo {
  description: string | null;
  forks: number;
  stars: number;
}

export interface FetchRepositoryOptions {
  baseUrl?: string;
  owner: string;
  repo: string;
  token?: string;
}

const DEFAULT_BASE_URL = "https://api.github.com";

/** In-process dedupe so the same repo is fetched once per build. */
const cache = new Map<string, Promise<RepositoryInfo | null>>();

const load = async (
  options: FetchRepositoryOptions
): Promise<RepositoryInfo | null> => {
  const { baseUrl = DEFAULT_BASE_URL, owner, repo, token } = options;
  const headers = new Headers({ Accept: "application/vnd.github+json" });
  // An Enterprise instance can be configured on plain HTTP; a bearer token is
  // never worth putting on the wire in cleartext, so it is dropped rather than
  // sent. The request still goes out — a public repo's counts render either way.
  if (token && new URL(baseUrl).protocol === "https:") {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${baseUrl}/repos/${owner}/${repo}`, {
    headers,
  });
  if (!response.ok) {
    return null;
  }

  // SAFETY: GitHub's `GET /repos/{owner}/{repo}` contract carries these three
  // fields on every 2xx response; a malformed body rejects into `loadSafe`.
  const data = (await response.json()) as {
    description: string | null;
    forks_count: number;
    stargazers_count: number;
  };
  return {
    description: data.description,
    forks: data.forks_count,
    stars: data.stargazers_count,
  };
};

const loadSafe = async (
  options: FetchRepositoryOptions
): Promise<RepositoryInfo | null> => {
  try {
    return await load(options);
  } catch {
    return null;
  }
};

/** Fetch repo info, deduped per `owner/repo` and never throwing. */
export const fetchRepositoryInfo = (
  options: FetchRepositoryOptions
): Promise<RepositoryInfo | null> => {
  const key = `${options.baseUrl ?? DEFAULT_BASE_URL}/${options.owner}/${options.repo}`;
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }

  const promise = loadSafe(options);
  cache.set(key, promise);
  return promise;
};
