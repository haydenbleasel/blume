import { join } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import { neutralizeUnsafeLinks } from "../safe-links.ts";
import type { Diagnostic } from "../types.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { asNumber, asString, getPath, isStringValue } from "./json.ts";
import { slugify, slugifyPath } from "./normalize.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "./types.ts";

/** What every REST-backed CMS source needs to be a staged, cached source. */
export interface RemoteSourceOptions {
  /**
   * Throw a `BlumeError` when the source cannot load as configured. Runs
   * before the cache is consulted: thrown from `fetchEntries` instead, a
   * misconfiguration would be served over by a stale snapshot with only an
   * offline warning.
   */
  assertConfigured?: () => void;
  /**
   * Pull every entry from the API; called on refresh and on each poll.
   * `warn` reports a problem with the content itself (an embed the API
   * couldn't resolve, a node with no Markdown), which the load returns
   * beside the entries; a load served from the snapshot repeats none.
   */
  fetchEntries: (
    warn: (diagnostic: Diagnostic) => void
  ) => Promise<SourceEntry[]>;
  name: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  prefix?: string;
  /** The adapter rebuilt on another context (`ContentSource.withContext`). */
  withContext?: (ctx: SourceContext) => ContentSource;
}

/**
 * The staged-source scaffolding a CMS adapter shares: a snapshot cache under
 * `.blume/cache/<source>/` (or a name-derived dir when constructed directly
 * as a custom source, without a context), cache-first dev loads, offline
 * fallback, `read()` for raw export, and an opt-in polling `watch`.
 */
export const remoteSource = (
  options: RemoteSourceOptions,
  ctx?: SourceContext
): ContentSource => {
  const cache = snapshotCache(
    ctx?.cacheDir ?? join(".blume", "cache", options.name)
  );
  let snapshot = new Map<string, SourceEntry>();

  const load = async (
    refresh = ctx?.refresh ?? true
  ): Promise<SourceLoadResult> => {
    options.assertConfigured?.();
    // Set only once a fetch succeeds, so a failed one that falls back to the
    // snapshot reports nothing about pages it never delivered.
    let warnings: Diagnostic[] = [];
    const result = await loadWithCache(
      options.name,
      cache,
      async () => {
        const found: Diagnostic[] = [];
        const entries = await options.fetchEntries((diagnostic) => {
          found.push(diagnostic);
        });
        warnings = found;
        return entries;
      },
      refresh
    );
    snapshot = new Map(result.entries.map((entry) => [entry.ref, entry]));
    return { ...result, diagnostics: [...result.diagnostics, ...warnings] };
  };

  const read = async (ref: string): Promise<string> => {
    const cached = snapshot.get(ref);
    if (cached) {
      return cached.raw ?? cached.body.text;
    }
    const all = await cache.read();
    return all.find((entry) => entry.ref === ref)?.raw ?? "";
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
    withContext: options.withContext,
  };
};

/** The frontmatter a CMS document maps to. */
export interface RemoteFrontmatter {
  description?: string;
  draft?: boolean;
  sidebar?: { order: number };
  title?: string;
}

/**
 * A staged entry: Markdown body plus the frontmatter it was mapped from,
 * written as `.mdx` when the body carries serializer output (see
 * `writesMdx`).
 */
export const stagedEntry = (
  slug: string,
  data: RemoteFrontmatter,
  markdown: string,
  lastModified: string | undefined,
  format: "md" | "mdx" = "md"
): SourceEntry => {
  const raw = matter.stringify(markdown, data);
  return {
    body: { format, text: markdown },
    // Spread into a fresh literal: `SourceEntry.data` wants an
    // index-signature type, which the named interface lacks.
    data: { ...data },
    hash: hashText(raw),
    lastModified,
    raw,
    ref: `${slug}.${format}`,
  };
};

/**
 * The error a source throws before its first request when the token its API
 * always requires is unset (Notion, Contentful's Delivery API). Sent without
 * one, the request could only fail, and the build would report the API's
 * wording as a fetch failure instead of the variable to set.
 */
export const missingSecretError = (name: string, env: string): BlumeError =>
  new BlumeError({
    code: "BLUME_MISSING_SECRET",
    message: `Source "${name}" needs ${env}, which is not set.`,
    severity: "error",
    suggestion: `Set ${env} in .env.local for local dev, or in your host's environment for production.`,
  });

/** How a source calls its CMS: the API's auth headers and an injectable fetch. */
export interface RestClient {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * How long one CMS request may take before the source gives up on it. A
 * stalled CMS would otherwise hold `scanProject()` — and every `blume dev`
 * rescan — indefinitely, and the cache fallback can only kick in once the
 * request rejects.
 */
export const REMOTE_TIMEOUT_MS = 30_000;

/**
 * GET a JSON endpoint. A non-2xx response is an error naming the status, so
 * the source's cache fallback reports why (`401 Unauthorized`) instead of a
 * parse failure on an error body; a request past {@link REMOTE_TIMEOUT_MS}
 * rejects with a `TimeoutError`.
 */
export const fetchJson = async (
  url: string,
  client: RestClient
): Promise<JsonValue> => {
  const doFetch = client.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url, {
    headers: { accept: "application/json", ...client.headers },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status} ${res.statusText}`.trim());
  }
  // SAFETY: the endpoint answered 2xx with a JSON body; whatever shape it
  // holds is narrowed by the caller's predicates before use.
  return (await res.json()) as JsonValue;
};

/** A query string from the fixed params plus a user's extra ones. */
export const queryString = (
  params: Record<string, string | undefined>
): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }
  return search.toString();
};

/** Field paths mapping a CMS document onto Blume meta + body. */
export interface RemoteFieldMap {
  /** Field holding the renderable body (rich text, or a Markdown string). */
  body?: string;
  /** Field holding the page description. */
  description?: string;
  /** Field holding the last-modified ISO date. */
  lastModified?: string;
  /** Field holding the sidebar order (a number); no default. */
  order?: string;
  /** Field holding the route slug. */
  slug?: string;
  /** Field holding the page title. */
  title?: string;
}

/** A field map with its defaults filled in; `order` is read only when set. */
export type RemoteFields = Required<Omit<RemoteFieldMap, "order">> &
  Pick<RemoteFieldMap, "order">;

/**
 * The slug a document's staged entry is named by. It falls back to the
 * document's id when the slug field is missing or slugifies to nothing (pure
 * punctuation), so distinct documents never collapse onto one
 * `untitled.md`; a slashed slug keeps its segments.
 */
export const documentSlug = (
  doc: JsonObject,
  slugField: string,
  id: string
): string =>
  slugifyPath(asString(getPath(doc, slugField)) ?? id) ||
  slugify(id) ||
  "untitled";

/**
 * Map a document to a staged entry named by its {@link documentSlug}. A
 * number in the `order` field, when one is mapped, becomes the page's
 * sidebar order. A string body is Markdown and passes through as `.md`, its
 * unsafe links reduced to their labels; any other shape goes to the CMS's
 * lowerer, and is written as `.mdx` when `lowersToMdx` (the source has
 * serializers, see `writesMdx`).
 */
export const documentEntry = (
  doc: JsonObject,
  fields: RemoteFields,
  id: string,
  lower: (body: JsonValue) => string,
  draft = false,
  lowersToMdx = false
): SourceEntry => {
  const slug = documentSlug(doc, fields.slug, id);
  const data: RemoteFrontmatter = {};
  const title = asString(getPath(doc, fields.title));
  const description = asString(getPath(doc, fields.description));
  if (title) {
    data.title = title;
  }
  if (description) {
    data.description = description;
  }
  if (draft) {
    data.draft = true;
  }
  const order = fields.order ? asNumber(getPath(doc, fields.order)) : undefined;
  if (order !== undefined) {
    data.sidebar = { order };
  }
  const body = getPath(doc, fields.body);
  let markdown = "";
  let format: "md" | "mdx" = "md";
  if (isStringValue(body)) {
    // The CMS's Markdown is its editors', not the site author's: a link whose
    // destination isn't a web, mail, or relative address (`javascript:`)
    // keeps only its label, as release notes do (see `safe-links.ts`).
    markdown = neutralizeUnsafeLinks(`${body.trimEnd()}\n`);
  } else if (body !== undefined) {
    markdown = lower(body);
    format = lowersToMdx ? "mdx" : "md";
  }
  return stagedEntry(
    slug,
    data,
    markdown,
    asString(getPath(doc, fields.lastModified)),
    format
  );
};
