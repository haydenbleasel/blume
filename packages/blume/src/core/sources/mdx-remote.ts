import picomatch from "picomatch";

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

// Include globs compile through picomatch — what the filesystem source's
// tinyglobby uses under the hood — so the same `include` array means the same
// thing on every source type: negation, character classes, nested braces, and
// extglobs included. Compiled once per enumeration, not per ref.

/** A file to fetch: its source-local ref plus where to read it from. */
interface RemoteRef {
  ref: string;
  fetchUrl: string;
  editUrl?: string;
}

// Hosts the GITHUB_TOKEN may be sent to. A configured `url` base can point at
// any server, and leaking the token there would hand a repo credential to an
// arbitrary third party.
const GITHUB_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

const githubHeaders = (url: string): Record<string, string> => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {};
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  return GITHUB_HOSTS.has(host) ? { authorization: `Bearer ${token}` } : {};
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
  const res = await doFetch(treeUrl, { headers: githubHeaders(treeUrl) });
  if (!res.ok) {
    throw new Error(`${treeUrl} -> ${res.status}`);
  }
  // SAFETY: GitHub's git/trees endpoint returns this envelope; a missing or
  // differently-typed field falls through the `?? []` and blob filters below.
  const body = (await res.json()) as {
    tree?: GithubTreeEntry[];
    truncated?: boolean;
  };
  const prefix = base ? `${base}/` : "";
  const included = picomatch(include);
  const refs = (body.tree ?? []).flatMap((node) => {
    if (!(node.type === "blob" && node.path.startsWith(prefix))) {
      return [];
    }
    const rel = node.path.slice(prefix.length);
    if (!included(rel)) {
      return [];
    }
    return [
      {
        editUrl: `https://github.com/${owner}/${repo}/edit/${ref}/${prefix}${rel}`,
        fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${prefix}${rel}`,
        ref: rel,
      },
    ];
  });
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

  // Validated up front in `load`, *before* the cached-fetch path: thrown from
  // inside `loadWithCache`'s fetch callback, a misconfiguration would be masked
  // as BLUME_SOURCE_FETCH_FAILED (no cache) or downgraded to a stale-cache
  // BLUME_SOURCE_OFFLINE warning (cache present).
  const assertConfigured = (): void => {
    if (options.github || (options.files && options.url)) {
      return;
    }
    throw new BlumeError({
      code: "BLUME_SOURCE_MISCONFIGURED",
      message: `Source "${options.name}" needs either { github } or { url, files }.`,
      severity: "error",
    });
  };

  const enumerate = async (): Promise<{
    refs: RemoteRef[];
    truncated: boolean;
  }> => {
    if (options.github) {
      return await enumerateGithub(options.github, options.include, doFetch);
    }
    const base = (options.url ?? "").replace(/\/$/u, "");
    const included = picomatch(options.include);
    const refs = (options.files ?? []).flatMap((ref) =>
      included(ref)
        ? [{ editUrl: `${base}/${ref}`, fetchUrl: `${base}/${ref}`, ref }]
        : []
    );
    return { refs, truncated: false };
  };

  const fetchEntry = async (item: RemoteRef): Promise<SourceEntry> => {
    const res = await doFetch(item.fetchUrl, {
      headers: githubHeaders(item.fetchUrl),
    });
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

  const load = async (
    refresh = ctx.refresh ?? true
  ): Promise<SourceLoadResult> => {
    assertConfigured();
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
                // SAFETY: fetch and decode failures throw Error instances;
                // only the message is read for the skip diagnostic.
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
      refresh
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
      ? pollingWatch(
          () => load(true),
          options.pollInterval,
          () => load()
        )
      : undefined,
  };
};
