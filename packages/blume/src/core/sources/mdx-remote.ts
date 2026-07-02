import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import type { Diagnostic } from "../types.ts";
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

/** Options for the built-in remote Markdown/MDX source. */
export interface MdxRemoteSourceOptions {
  name: string;
  prefix?: string;
  /** Raw base URL for `files`, e.g. `https://raw.githubusercontent.com/o/r/main/docs`. */
  url?: string;
  /** Explicit source-relative file paths to fetch from `url`. */
  files?: string[];
  /** Enumerate a GitHub repo subtree via the git-trees API. */
  github?: { owner: string; repo: string; ref: string; path: string };
  include: string[];
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/u;

/** Escape a literal character for embedding in a RegExp. */
const escapeChar = (char: string): string =>
  REGEX_SPECIAL.test(char) ? `\\${char}` : char;

/** Compile a glob (`**`, `*`, `?`, `{a,b}`) into an anchored RegExp. */
const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 2;
        if (pattern[i] === "/") {
          i += 1;
        }
        continue;
      }
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) {
        const options = pattern
          .slice(i + 1, end)
          .split(",")
          .map((part) => [...part].map(escapeChar).join(""))
          .join("|");
        source += `(?:${options})`;
        i = end + 1;
        continue;
      }
    }
    source += escapeChar(char);
    i += 1;
  }
  return new RegExp(`^${source}$`, "u");
};

/** Whether a ref matches any of the include globs. */
const matchesInclude = (ref: string, patterns: string[]): boolean =>
  patterns.some((pattern) => globToRegExp(pattern).test(ref));

/** A file to fetch: its source-local ref plus where to read it from. */
interface RemoteRef {
  ref: string;
  fetchUrl: string;
  editUrl?: string;
}

const githubHeaders = (): Record<string, string> => {
  const token = process.env.GITHUB_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
};

interface GithubTreeEntry {
  path: string;
  type: string;
}

/** Enumerate a GitHub repo subtree, mapping blobs to remote refs. */
const enumerateGithub = async (
  github: { owner: string; repo: string; ref: string; path: string },
  include: string[],
  doFetch: typeof fetch
): Promise<{ refs: RemoteRef[]; truncated: boolean }> => {
  const { owner, repo, ref } = github;
  const base = github.path.replaceAll(/^\/|\/$/gu, "");
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const res = await doFetch(treeUrl, { headers: githubHeaders() });
  if (!res.ok) {
    throw new Error(`${treeUrl} -> ${res.status}`);
  }
  const body = (await res.json()) as {
    tree?: GithubTreeEntry[];
    truncated?: boolean;
  };
  const prefix = base ? `${base}/` : "";
  const refs = (body.tree ?? [])
    .filter((node) => node.type === "blob" && node.path.startsWith(prefix))
    .map((node) => node.path.slice(prefix.length))
    .filter((rel) => matchesInclude(rel, include))
    .map((rel) => ({
      editUrl: `https://github.com/${owner}/${repo}/edit/${ref}/${prefix}${rel}`,
      fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${prefix}${rel}`,
      ref: rel,
    }));
  // GitHub caps the recursive tree response (~100k entries / 7MB) and flags it
  // with `truncated`; ignoring it would silently import only part of the repo.
  return { refs, truncated: body.truncated === true };
};

/**
 * Remote Markdown/MDX content source. Fetches raw `.md`/`.mdx` over HTTP and
 * passes the text straight through `normalizeEntry`. A snapshot under
 * `.blume/cache/<source>/` makes rebuilds offline-tolerant.
 */
export const mdxRemoteSource = (
  options: MdxRemoteSourceOptions,
  ctx: SourceContext
): ContentSource => {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const cache = snapshotCache(ctx.cacheDir);
  let snapshot = new Map<string, SourceEntry>();

  const enumerate = async (): Promise<{
    refs: RemoteRef[];
    truncated: boolean;
  }> => {
    if (options.github) {
      return await enumerateGithub(options.github, options.include, doFetch);
    }
    if (options.files && options.url) {
      const base = options.url.replace(/\/$/u, "");
      const refs = options.files
        .filter((ref) => matchesInclude(ref, options.include))
        .map((ref) => ({
          editUrl: `${base}/${ref}`,
          fetchUrl: `${base}/${ref}`,
          ref,
        }));
      return { refs, truncated: false };
    }
    throw new BlumeError({
      code: "BLUME_SOURCE_MISCONFIGURED",
      message: `Source "${options.name}" needs either { github } or { url, files }.`,
      severity: "error",
    });
  };

  const fetchEntry = async (item: RemoteRef): Promise<SourceEntry> => {
    const res = await doFetch(item.fetchUrl, { headers: githubHeaders() });
    if (!res.ok) {
      throw new Error(`${item.fetchUrl} -> ${res.status}`);
    }
    const text = await res.text();
    const parsed = matter(text);
    const format = item.ref.toLowerCase().endsWith(".mdx") ? "mdx" : "md";
    return {
      body: { format, text: parsed.content },
      data: parsed.data,
      editUrl: item.editUrl,
      hash: hashText(text),
      raw: text,
      ref: item.ref,
    };
  };

  const load = async (): Promise<SourceLoadResult> => {
    const skipped: Diagnostic[] = [];
    const result = await loadWithCache(
      options.name,
      cache,
      async () => {
        const { refs, truncated } = await enumerate();
        if (truncated) {
          skipped.push({
            code: "BLUME_SOURCE_TRUNCATED",
            message: `Source "${options.name}" hit GitHub's tree listing limit; some files were not enumerated. Narrow the source path or split the repo.`,
            severity: "warning",
          });
        }
        const settled = await Promise.all(
          refs.map(async (ref) => {
            try {
              return await fetchEntry(ref);
            } catch (error) {
              skipped.push({
                code: "BLUME_SOURCE_FETCH_FAILED",
                message: `Source "${options.name}" skipped "${ref.ref}" (${(error as Error).message}); the rest were imported.`,
                severity: "warning",
              });
              return null;
            }
          })
        );
        const entries = settled.filter(
          (entry): entry is SourceEntry => entry !== null
        );
        // Only a total wipeout is a hard failure — let loadWithCache fall back
        // to cache or fail loudly rather than silently importing nothing. A
        // partial failure keeps the healthy pages and warns about the rest.
        if (refs.length > 0 && entries.length === 0) {
          skipped.length = 0;
          throw new Error(`all ${refs.length} remote file(s) failed to fetch`);
        }
        return entries;
      },
      ctx.refresh ?? true
    );
    snapshot = new Map(result.entries.map((entry) => [entry.ref, entry]));
    return {
      ...result,
      diagnostics: [...result.diagnostics, ...skipped],
    };
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
      ? pollingWatch(load, options.pollInterval)
      : undefined,
  };
};
