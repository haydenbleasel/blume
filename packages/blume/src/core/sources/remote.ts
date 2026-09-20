import { join } from "pathe";

import matter from "../frontmatter.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { asString, getPath, isStringValue } from "./json.ts";
import { slugify, slugifyPath } from "./normalize.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "./types.ts";

/** What every REST-backed CMS source needs to be a staged, cached source. */
export interface RemoteSourceOptions {
  /** Pull every entry from the API; called on refresh and on each poll. */
  fetchEntries: () => Promise<SourceEntry[]>;
  name: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  prefix?: string;
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
    const result = await loadWithCache(
      options.name,
      cache,
      options.fetchEntries,
      refresh
    );
    snapshot = new Map(result.entries.map((entry) => [entry.ref, entry]));
    return result;
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
  };
};

/** The frontmatter a CMS document maps to. */
export interface RemoteFrontmatter {
  description?: string;
  draft?: boolean;
  title?: string;
}

/** A staged entry: Markdown body plus the frontmatter it was mapped from. */
export const stagedEntry = (
  slug: string,
  data: RemoteFrontmatter,
  markdown: string,
  lastModified: string | undefined
): SourceEntry => {
  const raw = matter.stringify(markdown, data);
  return {
    body: { format: "md", text: markdown },
    // Spread into a fresh literal: `SourceEntry.data` wants an
    // index-signature type, which the named interface lacks.
    data: { ...data },
    hash: hashText(raw),
    lastModified,
    raw,
    ref: `${slug}.md`,
  };
};

/** How a source calls its CMS: the API's auth headers and an injectable fetch. */
export interface RestClient {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * GET a JSON endpoint. A non-2xx response is an error naming the status, so
 * the source's cache fallback reports why (`401 Unauthorized`) instead of a
 * parse failure on an error body.
 */
export const fetchJson = async (
  url: string,
  client: RestClient
): Promise<JsonValue> => {
  const doFetch = client.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url, {
    headers: { accept: "application/json", ...client.headers },
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
  /** Field holding the route slug. */
  slug?: string;
  /** Field holding the page title. */
  title?: string;
}

/**
 * Map a document to a staged entry. The slug falls back to the document's id
 * when the slug field is missing or slugifies to nothing (pure punctuation),
 * so distinct documents never collapse onto one `untitled.md`; a slashed
 * slug keeps its segments. A string body is Markdown and passes through; any
 * other shape goes to the CMS's lowerer.
 */
export const documentEntry = (
  doc: JsonObject,
  fields: Required<RemoteFieldMap>,
  id: string,
  lower: (body: JsonValue) => string,
  draft = false
): SourceEntry => {
  const slugValue = asString(getPath(doc, fields.slug)) ?? id;
  const slug = slugifyPath(slugValue) || slugify(id) || "untitled";
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
  const body = getPath(doc, fields.body);
  let markdown = "";
  if (isStringValue(body)) {
    markdown = `${body.trimEnd()}\n`;
  } else if (body !== undefined) {
    markdown = lower(body);
  }
  return stagedEntry(
    slug,
    data,
    markdown,
    asString(getPath(doc, fields.lastModified))
  );
};
