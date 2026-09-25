import type { Definition, Heading, Link, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString as mdastToString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import stringWidth from "string-width";

import matter from "../frontmatter.ts";
import { PUBLIC_API_URL } from "../github.ts";
import { neutralizeUnsafeLinks } from "../safe-links.ts";
import { columnsPrefix } from "../text-width.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import { destination, escapeMarkdownText } from "./lower.ts";
import { REMOTE_TIMEOUT_MS } from "./remote.ts";
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
  /**
   * The site's own URL (`deployment.site`). A link in the notes back to it
   * becomes root-relative, the way a page links to another page.
   */
  site?: string;
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

const DEFAULT_LIMIT = 100;
const PER_PAGE = 100;

const LEADING_V = /^v/iu;
const NON_SLUG = /[^a-z0-9]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;

// `blume audit` grades meta descriptions against the 110–160 display-column
// search snippet range (audit/types.ts thresholds), so the derived summary
// budgets in the same columns and aims for the longest word-boundary cut
// under the cap.
const DESCRIPTION_MAX = 160;
const DESCRIPTION_MIN = 110;

// Changesets-generated release bullets open with the changeset's short commit
// hash (`- cf8fa22: Fix …`) — noise in a search snippet. Stripped from the
// raw lines (where the bullet anchor still exists) before parsing.
const CHANGESET_HASH = /^(?<mark>\s*(?:[-*+]|\d+[.)])\s+)[0-9a-f]{7,40}:\s+/gmu;
const WHITESPACE = /\s+/gu;
const TRAILING_FRAGMENT = /[\s,;:.—–-]+$/u;

/** Block nodes with no place in a search snippet. */
const NON_PROSE = new Set(["code", "heading", "html", "thematicBreak"]);

/**
 * Derive a meta description from release notes: GitHub-flavored markdown
 * parsed to mdast and reduced to the plain text of its prose blocks —
 * section headings ("### Patch Changes"), code fences, and changesets'
 * commit-hash bullet prefixes dropped; link/emphasis text and inline code
 * content kept — then cut at a word boundary to fit the search snippet cap.
 * Undefined when the notes have no prose at all.
 */
const releaseDescription = (body: string): string | undefined => {
  const tree = fromMarkdown(body.replaceAll(CHANGESET_HASH, "$<mark>"), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const text = tree.children
    .filter((node) => !NON_PROSE.has(node.type))
    // Images vanish (their alt is not prose) and raw HTML/JSX tags drop,
    // matching what a reader of the rendered notes would see as text.
    .map((node) =>
      mdastToString(node, { includeHtml: false, includeImageAlt: false })
    )
    .join(" ")
    .replaceAll(WHITESPACE, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  if (stringWidth(text) <= DESCRIPTION_MAX) {
    return text;
  }
  // Cut before the cap at a word boundary (kept only when it doesn't drop the
  // summary under the minimum), shed any dangling punctuation, and mark the cut.
  const slice = columnsPrefix(text, DESCRIPTION_MAX - 1);
  const boundary = slice.lastIndexOf(" ");
  const head = (
    boundary !== -1 && stringWidth(slice.slice(0, boundary)) >= DESCRIPTION_MIN
      ? slice.slice(0, boundary)
      : slice
  ).replace(TRAILING_FRAGMENT, "");
  return `${head}…`;
};

/** Every heading in a tree, in document order (lists and quotes included). */
const headingsIn = (node: Nodes): Heading[] => {
  if (node.type === "heading") {
    return [node];
  }
  const found: Heading[] = [];
  if ("children" in node) {
    for (const child of node.children) {
      found.push(...headingsIn(child));
    }
  }
  return found;
};

/**
 * Lift the notes' headings so the shallowest is an h2. The release page's
 * title is its h1, and changesets opens every section at `### Patch Changes`,
 * which would skip a level on every page. Only ATX headings can sit deeper
 * than h2, so each lift drops leading `#`s; headings are read from the parsed
 * tree, so a `#` inside a code fence is never touched.
 */
const liftHeadings = (body: string): string => {
  const headings = headingsIn(
    fromMarkdown(body, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    })
  );
  const lift = Math.min(...headings.map((heading) => heading.depth)) - 2;
  if (headings.length === 0 || lift <= 0) {
    return body;
  }
  let lifted = body;
  // Back to front, so each cut leaves the earlier offsets valid.
  for (const heading of headings.toReversed()) {
    const marker = lifted.indexOf("#", heading.position?.start.offset);
    lifted = lifted.slice(0, marker) + lifted.slice(marker + lift);
  }
  return lifted;
};

const WEB_PROTOCOL = /^https?:$/u;
const TITLE_SPECIALS = /["\\]/gu;

/** The origin of an http(s) site URL, or null when there is none. */
const webOrigin = (site?: string): string | null => {
  const parsed = site ? URL.parse(site) : null;
  return parsed && WEB_PROTOCOL.test(parsed.protocol) ? parsed.origin : null;
};

/** A link title as Markdown carries it, or nothing when there is none. */
const titleSuffix = (title?: string | null): string =>
  title ? ` "${title.replaceAll(TITLE_SPECIALS, String.raw`\$&`)}"` : "";

/**
 * The Markdown a link or definition to one of the site's own pages becomes,
 * pointing at `path` instead. An inline link keeps its label as written, and
 * an autolink keeps showing the URL it was written as.
 */
const rewrittenLink = (
  markdown: string,
  node: Definition | Link,
  path: string
): string => {
  const target = `${destination(path)}${titleSuffix(node.title)}`;
  if (node.type === "definition") {
    return `[${node.label ?? node.identifier}]: ${target}`;
  }
  const start = node.position?.start.offset ?? 0;
  if (markdown[start] !== "[") {
    return `[${escapeMarkdownText(mdastToString(node))}](${target})`;
  }
  const first = node.children.at(0)?.position?.start.offset ?? start + 1;
  const last = node.children.at(-1)?.position?.end.offset ?? first;
  return `[${markdown.slice(first, last)}](${target})`;
};

/**
 * Point the notes' links to the site itself (`https://acme.dev/docs/x` when
 * `deployment.site` is `https://acme.dev`) at the root-relative path, as a
 * page on the site links to another: an absolute link hardcodes production,
 * so it leaves a preview deploy and trips `blume audit`'s own-origin check.
 */
const relativizeOwnLinks = (markdown: string, site?: string): string => {
  const origin = webOrigin(site);
  if (!origin) {
    return markdown;
  }
  const spans: { end: number; start: number; text: string }[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === "link" || node.type === "definition") {
      const parsed = URL.parse(node.url);
      if (parsed?.origin === origin) {
        spans.push({
          // fromMarkdown stamps every node's position.
          end: node.position?.end.offset ?? 0,
          start: node.position?.start.offset ?? 0,
          text: rewrittenLink(
            markdown,
            node,
            `${parsed.pathname}${parsed.search}${parsed.hash}`
          ),
        });
        return;
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(
    fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    })
  );
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += markdown.slice(cursor, span.start) + span.text;
    cursor = span.end;
  }
  return out + markdown.slice(cursor);
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
 * The changelog frontmatter one release lowers to. `title`/`type` are always
 * assigned (optional only so assignment order can keep the emitted YAML key
 * order — and so each entry's content hash — stable).
 */
interface ChangelogFrontmatter {
  changelog: { category: string; version: string };
  date: string;
  seo?: { description: string };
  title?: string;
  type?: string;
}

/**
 * Lower one release to a staged Markdown entry: the notes become the body,
 * `type: changelog` frontmatter (title/date/version/category) drives the
 * generated `/changelog` timeline and RSS feed, and a summary derived from the
 * notes becomes the release page's meta description.
 */
const releaseToEntry = (release: GithubRelease, site?: string): SourceEntry => {
  const version = release.tag_name.replace(LEADING_V, "");
  const title = release.name?.trim() || release.tag_name;
  const date = release.published_at ?? release.created_at;
  const category = release.prerelease ? "Prerelease" : "Release";
  // Release notes are the repository's content, not the site author's, so a
  // link whose destination isn't a web, mail, or relative address
  // (`javascript:`, `data:`) keeps only its label (see `safe-links.ts`), and
  // a link back to the site becomes root-relative.
  const body = liftHeadings(
    relativizeOwnLinks(
      neutralizeUnsafeLinks(
        (release.body ?? "").replaceAll("\r\n", "\n")
      ).trim(),
      site
    )
  );
  // A summary in `seo.description` gives each release page a unique meta
  // description (instead of the site-wide fallback) without also rendering the
  // visible lede paragraph a top-level `description` would add.
  const description = releaseDescription(body);
  // Assignment order matters: js-yaml serializes keys in insertion order, so
  // `seo` lands between `date` and `title` exactly as it always has.
  const data: ChangelogFrontmatter = {
    changelog: { category, version },
    date,
  };
  if (description) {
    data.seo = { description };
  }
  data.title = title;
  data.type = "changelog";
  const raw = matter.stringify(`${body}\n`, data);
  const fallbackRef = `release-${release.id}`;
  const ref = `${slugifyTag(release.tag_name) || fallbackRef}.md`;
  return {
    body: { format: "md", text: body },
    // Spread: `SourceEntry.data` is an open dictionary, which the interface
    // (no index signature) only satisfies as a fresh object literal.
    data: { ...data },
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
  const base = (options.baseUrl ?? PUBLIC_API_URL).replace(/\/$/u, "");
  const max = options.limit ?? DEFAULT_LIMIT;
  const cache = snapshotCache(ctx.cacheDir);
  let snapshot = new Map<string, SourceEntry>();

  const include = (release: GithubRelease): boolean =>
    (options.drafts || !release.draft) &&
    (options.prereleases || !release.prerelease);

  // Each page gets {@link REMOTE_TIMEOUT_MS}, body included: an API that
  // accepts the connection and never answers would otherwise hold the scan,
  // and so the build or every dev rescan, indefinitely. The timeout's error
  // names the URL and the limit, so the empty-changelog warning says what
  // stalled instead of only that an operation was aborted.
  const fetchPage = async (page: number): Promise<GithubRelease[]> => {
    const url = `${base}/repos/${options.owner}/${options.repo}/releases?per_page=${PER_PAGE}&page=${page}`;
    try {
      const res = await doFetch(url, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`${url} -> ${res.status}`);
      }
      // SAFETY: GitHub's releases endpoint returns a JSON array of release
      // objects; `GithubRelease` models only the fields the adapter reads.
      return (await res.json()) as GithubRelease[];
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(
          `${url} did not respond within ${REMOTE_TIMEOUT_MS / 1000}s`,
          { cause: error }
        );
      }
      throw error;
    }
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
          return releases.map((release) =>
            releaseToEntry(release, options.site)
          );
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
      // SAFETY: everything thrown on this path is an Error — fetch rejects
      // with a TypeError, fetchPage and loadWithCache throw Error instances.
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
    // Releases are written once, in one language: no locale can translate them.
    monolingual: true,
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
    withContext: (next) => githubReleasesSource(options, next),
  };
};
