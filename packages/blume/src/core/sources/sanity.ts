import matter from "gray-matter";
import { join } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import { slugify } from "./normalize.ts";
import { portableTextToMarkdown } from "./portable-text.ts";
import type { PortableTextBlock } from "./portable-text.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "./types.ts";

/** The slice of `@sanity/client` this adapter relies on (so it's mockable). */
export interface SanityClientLike {
  fetch: <T = unknown>(query: string) => Promise<T>;
}

/** Field paths mapping a Sanity document onto Blume meta + body. */
export interface SanityFieldMap {
  /** Frontmatter title; default `title`. */
  title?: string;
  /** Frontmatter description; default `description`. */
  description?: string;
  /** Route slug (dot path); default `slug.current`. */
  slug?: string;
  /** Portable Text body field; default `body`. */
  body?: string;
  /** Last-modified ISO date; default `_updatedAt`. */
  lastModified?: string;
}

export interface SanitySourceOptions {
  name: string;
  prefix?: string;
  projectId: string;
  dataset: string;
  /** Sanity API version (a date); default `2024-01-01`. */
  apiVersion?: string;
  /** GROQ query selecting the documents to import. */
  query: string;
  fields?: SanityFieldMap;
  /** Custom Portable Text block serializers, keyed by `_type`. */
  serializers?: Record<string, (block: PortableTextBlock) => string>;
  /** Read token for private datasets; defaults to `SANITY_TOKEN`. */
  token?: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Injected for tests; otherwise built from `@sanity/client`. */
  client?: SanityClientLike;
}

const IMAGE_REF = /^image-(?<id>[a-f0-9]+)-(?<dims>\d+x\d+)-(?<ext>\w+)$/u;

/** Resolve a dot path (`slug.current`) against a document. */
const getPath = (doc: Record<string, unknown>, path: string): unknown => {
  let current: unknown = doc;
  for (const key of path.split(".")) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return;
    }
  }
  return current;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Build a Sanity CDN URL from an image asset `_ref`. */
const imageUrlFromRef = (
  ref: string,
  projectId: string,
  dataset: string
): string | null => {
  const match = ref.match(IMAGE_REF);
  if (!match?.groups) {
    return null;
  }
  const { id, dims, ext } = match.groups;
  return `https://cdn.sanity.io/images/${projectId}/${dataset}/${id}-${dims}.${ext}`;
};

const resolveClient = async (
  options: SanitySourceOptions,
  preview: boolean
): Promise<SanityClientLike> => {
  if (options.client) {
    return options.client;
  }
  let createClient: (config: Record<string, unknown>) => SanityClientLike;
  try {
    ({ createClient } = (await import("@sanity/client")) as {
      createClient: (config: Record<string, unknown>) => SanityClientLike;
    });
  } catch {
    throw new BlumeError({
      code: "BLUME_SOURCE_SDK_MISSING",
      message: `Source "${options.name}" needs "@sanity/client". Install it (e.g. \`npm install @sanity/client\`).`,
      severity: "error",
    });
  }
  return createClient({
    apiVersion: options.apiVersion ?? "2024-01-01",
    dataset: options.dataset,
    // Preview reads draft documents through the API; published builds use the CDN.
    perspective: preview ? "previewDrafts" : "published",
    projectId: options.projectId,
    token: options.token ?? process.env.SANITY_TOKEN,
    useCdn: !preview,
  });
};

/**
 * Sanity content source. Runs a GROQ query, maps each document's fields to Blume
 * frontmatter and its Portable Text body to Markdown, and stages the result.
 */
export const sanitySource = (
  options: SanitySourceOptions,
  ctx?: SourceContext
): ContentSource => {
  const fields = options.fields ?? {};
  // When constructed directly (custom-source SPI) without a context, cache under
  // a name-derived dir relative to the project; the built-in type passes a ctx.
  const cache = snapshotCache(
    ctx?.cacheDir ?? join(".blume", "cache", options.name)
  );
  let snapshot = new Map<string, SourceEntry>();

  const toEntry = (doc: Record<string, unknown>): SourceEntry => {
    const slugValue =
      asString(getPath(doc, fields.slug ?? "slug.current")) ??
      asString(doc._id) ??
      "untitled";
    const slug = slugify(slugValue) || "untitled";

    const data: Record<string, unknown> = {};
    const title = asString(getPath(doc, fields.title ?? "title"));
    const description = asString(
      getPath(doc, fields.description ?? "description")
    );
    if (title) {
      data.title = title;
    }
    if (description) {
      data.description = description;
    }

    const blocks = (getPath(doc, fields.body ?? "body") ??
      []) as PortableTextBlock[];
    const markdown = Array.isArray(blocks)
      ? portableTextToMarkdown(blocks, {
          imageUrl: (block) => {
            const ref = (block.asset as { _ref?: string } | undefined)?._ref;
            return ref
              ? imageUrlFromRef(ref, options.projectId, options.dataset)
              : null;
          },
          serializers: options.serializers,
        })
      : "";

    const raw = matter.stringify(markdown, data);
    return {
      body: { format: "md", text: markdown },
      data,
      hash: hashText(raw),
      lastModified: asString(getPath(doc, fields.lastModified ?? "_updatedAt")),
      raw,
      ref: `${slug}.md`,
    };
  };

  const load = async (): Promise<SourceLoadResult> => {
    const result = await loadWithCache(
      options.name,
      cache,
      async () => {
        const client = await resolveClient(options, ctx?.preview ?? false);
        const docs = await client.fetch<Record<string, unknown>[]>(
          options.query
        );
        return docs.map(toEntry);
      },
      ctx?.refresh ?? true
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
    return all.find((e) => e.ref === ref)?.raw ?? "";
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
