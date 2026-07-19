import matter from "../frontmatter.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "./types.ts";

/** Options for the built-in GitHub Releases changelog source. */
export interface GithubReleasesSourceOptions {
  /** GitHub REST API base; overridable for GitHub Enterprise / tests. */
  baseUrl?: string;
  /** Include draft releases (needs a token with repo write access). Default off. */
  drafts?: boolean;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Cap the number of releases materialized, newest-first. Default 100. */
  limit?: number;
  name: string;
  /** Repository owner (user or org). */
  owner: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Namespaces the source's routes under `/<prefix>/`; e.g. `changelog`. */
  prefix?: string;
  /** Include prereleases. Default off. */
  prereleases?: boolean;
  /** Repository name. */
  repo: string;
}

/** The subset of the GitHub release payload the adapter reads. */
interface GithubRelease {
  body: string | null;
  created_at: string;
  draft: boolean;
  html_url: string;
  id: number;
  name: string | null;
  prerelease: boolean;
  published_at: string | null;
  tag_name: string;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_LIMIT = 100;
const PER_PAGE = 100;

const LEADING_V = /^v/iu;
const NON_SLUG = /[^a-z0-9]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;

// `blume audit` grades meta descriptions against the 110–160 character search
// snippet range (audit/types.ts thresholds), so the derived summary aims for
// the longest word-boundary cut under the cap.
const DESCRIPTION_MAX = 160;
const DESCRIPTION_MIN = 110;

const CODE_FENCE = /```[\s\S]*?```/gu;
const HEADING_LINE = /^#{1,6}\s.*$/gmu;
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/u;
// Changesets-generated release bullets open with the changeset's short commit
// hash (`- cf8fa22: Fix …`) — noise in a search snippet.
const CHANGESET_HASH = /^[0-9a-f]{7,40}:\s+/u;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/gu;
const LINK = /\[(?<text>[^\]]*)\]\([^)]*\)/gu;
const INLINE_CODE = /`(?<code>[^`]+)`/gu;
// Tag-shaped only: a bare `<` in prose must not swallow text up to a later `>`.
const HTML_OR_JSX = /<\/?[a-zA-Z][^\n<>]*>|<\/?>/gu;
const MARKDOWN_PUNCT = /[*_~>]+/gu;
const WHITESPACE = /\s+/gu;
const TRAILING_FRAGMENT = /[\s,;:.—–-]+$/u;

/**
 * Derive a meta description from release notes: markdown reduced to plain
 * text — section headings ("### Patch Changes") and changesets' commit-hash
 * bullet prefixes dropped — then cut at a word boundary to fit the search
 * snippet cap. Undefined when the notes have no prose at all.
 */
const releaseDescription = (body: string): string | undefined => {
  const text = body
    .replaceAll(CODE_FENCE, " ")
    .replaceAll(HEADING_LINE, "")
    .split("\n")
    .map((line) => line.replace(LIST_MARK, "").replace(CHANGESET_HASH, ""))
    .join("\n")
    .replaceAll(IMAGE, " ")
    .replaceAll(LINK, "$<text>")
    .replaceAll(INLINE_CODE, "$<code>")
    .replaceAll(HTML_OR_JSX, " ")
    .replaceAll(MARKDOWN_PUNCT, " ")
    .replaceAll(WHITESPACE, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  if (text.length <= DESCRIPTION_MAX) {
    return text;
  }
  // Cut before the cap at a word boundary (kept only when it doesn't drop the
  // summary under the minimum), shed any dangling punctuation, and mark the cut.
  const slice = text.slice(0, DESCRIPTION_MAX - 1);
  const boundary = slice.lastIndexOf(" ");
  const head = (
    boundary >= DESCRIPTION_MIN ? slice.slice(0, boundary) : slice
  ).replace(TRAILING_FRAGMENT, "");
  return `${head}…`;
};

/** Slugify a tag into a stable, URL-safe source ref (`v1.2.0` -> `v1-2-0`). */
const slugifyTag = (tag: string): string =>
  tag.toLowerCase().replaceAll(NON_SLUG, "-").replaceAll(EDGE_DASHES, "");

/** Build request headers, reading `GITHUB_TOKEN` fresh at call time. */
const githubHeaders = (): Headers => {
  const headers = new Headers({ Accept: "application/vnd.github+json" });
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
};

/**
 * Lower one release to a staged Markdown entry: the notes become the body,
 * `type: changelog` frontmatter (title/date/version/category) drives the
 * generated `/changelog` timeline and RSS feed, and a summary derived from the
 * notes becomes the release page's meta description.
 */
const releaseToEntry = (release: GithubRelease): SourceEntry => {
  const version = release.tag_name.replace(LEADING_V, "");
  const title = release.name?.trim() || release.tag_name;
  const date = release.published_at ?? release.created_at;
  const category = release.prerelease ? "Prerelease" : "Release";
  const body = (release.body ?? "").replaceAll("\r\n", "\n").trim();
  // A summary in `seo.description` gives each release page a unique meta
  // description (instead of the site-wide fallback) without also rendering the
  // visible lede paragraph a top-level `description` would add.
  const description = releaseDescription(body);
  const data = {
    changelog: { category, version },
    date,
    ...(description ? { seo: { description } } : {}),
    title,
    type: "changelog",
  };
  const raw = matter.stringify(`${body}\n`, data);
  const fallbackRef = `release-${release.id}`;
  const ref = `${slugifyTag(release.tag_name) || fallbackRef}.md`;
  return {
    body: { format: "md", text: body },
    data,
    editUrl: release.html_url,
    hash: hashText(raw),
    lastModified: date,
    raw,
    ref,
  };
};

/**
 * GitHub Releases content source. Pulls a repo's releases from the REST API and
 * materializes each as a `type: changelog` entry, so a project's release notes
 * become its changelog with no files to maintain. A private repo authenticates
 * with `GITHUB_TOKEN`. A snapshot under `.blume/cache/<source>/` keeps rebuilds
 * offline-tolerant.
 */
export const githubReleasesSource = (
  options: GithubReleasesSourceOptions,
  ctx: SourceContext
): ContentSource => {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
  const max = options.limit ?? DEFAULT_LIMIT;
  const cache = snapshotCache(ctx.cacheDir);
  let snapshot = new Map<string, SourceEntry>();

  const include = (release: GithubRelease): boolean =>
    (options.drafts || !release.draft) &&
    (options.prereleases || !release.prerelease);

  const fetchPage = async (page: number): Promise<GithubRelease[]> => {
    const url = `${base}/repos/${options.owner}/${options.repo}/releases?per_page=${PER_PAGE}&page=${page}`;
    const res = await doFetch(url, { headers: githubHeaders() });
    if (!res.ok) {
      throw new Error(`${url} -> ${res.status}`);
    }
    return (await res.json()) as GithubRelease[];
  };

  const fetchReleases = async (): Promise<GithubRelease[]> => {
    const collected: GithubRelease[] = [];
    let page = 1;
    while (collected.length < max) {
      // oxlint-disable-next-line no-await-in-loop -- pages are sequential: each page's length decides whether another exists.
      const batch = await fetchPage(page);
      collected.push(...batch.filter(include));
      if (batch.length < PER_PAGE) {
        break;
      }
      page += 1;
    }
    return collected.slice(0, max);
  };

  const load = async (
    refresh = ctx.refresh ?? true
  ): Promise<SourceLoadResult> => {
    try {
      const result = await loadWithCache(
        options.name,
        cache,
        async () => {
          const releases = await fetchReleases();
          return releases.map(releaseToEntry);
        },
        refresh
      );
      snapshot = new Map(result.entries.map((entry) => [entry.ref, entry]));
      return result;
    } catch (error) {
      // A changelog is supplementary. When releases can't be fetched and nothing
      // is cached (e.g. CI or a deploy without a `GITHUB_TOKEN` for a private
      // repo), degrade to an empty changelog with a warning rather than failing
      // the whole build.
      snapshot = new Map();
      return {
        diagnostics: [
          {
            code: "BLUME_SOURCE_UNAVAILABLE",
            message: `Source "${options.name}" could not fetch GitHub releases (${(error as Error).message}); the changelog will be empty. Set GITHUB_TOKEN to include it (required for a private repository).`,
            severity: "warning",
          },
        ],
        entries: [],
      };
    }
  };

  const read = async (ref: string): Promise<string> => {
    const cached = snapshot.get(ref);
    if (cached) {
      return cached.raw ?? cached.body.text;
    }
    const all = await cache.read();
    const entry = all.find((e) => e.ref === ref);
    return entry?.raw ?? entry?.body.text ?? "";
  };

  return {
    load,
    name: options.name,
    prefix: options.prefix,
    read,
    staged: true,
    watch: options.pollInterval
      ? pollingWatch(
          () => load(true),
          options.pollInterval,
          () => load()
        )
      : undefined,
  };
};
