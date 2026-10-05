import { join } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import { nodeRequire } from "../node-require.ts";
import { neutralizeUnsafeLinks } from "../safe-links.ts";
import type { Diagnostic } from "../types.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import type { JsonObject } from "./json.ts";
import { asString, getPath, isStringValue } from "./json.ts";
import { writesMdx } from "./lower.ts";
import { slugify, slugifyPath } from "./normalize.ts";
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
  /** Body field, Portable Text or a Markdown string; default `body`. */
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

/** A document as the GROQ query returns it. */
type SanityDocument = JsonObject;

/** The frontmatter fields this adapter maps from a document. */
interface SanityFrontmatter {
  description?: string;
  title?: string;
}

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

/** The `createClient` config slice this adapter passes. */
interface SanityClientConfig {
  apiVersion: string;
  dataset: string;
  perspective: "previewDrafts" | "published";
  projectId: string;
  token: string | undefined;
  useCdn: boolean;
}

const resolveClient = (
  options: SanitySourceOptions,
  preview: boolean
): SanityClientLike => {
  if (options.client) {
    return options.client;
  }
  let createClient: (config: SanityClientConfig) => SanityClientLike;
  try {
    // `require`, not `import()`: an ejected app scans in `astro:build:done`
    // (see `core/node-require.ts`).
    // SAFETY: `@sanity/client` is an optional dependency; its `createClient`
    // accepts a superset of this config slice and returns a client exposing
    // the `fetch` method this adapter uses.
    ({ createClient } = nodeRequire("@sanity/client") as {
      createClient: (config: SanityClientConfig) => SanityClientLike;
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

  const toEntry = (doc: SanityDocument): SourceEntry => {
    const slugValue =
      asString(getPath(doc, fields.slug ?? "slug.current")) ??
      asString(doc._id) ??
      "untitled";
    // Fall back to the unique `_id` when a slug (e.g. a non-ASCII `slug.current`)
    // slugifies to empty, so distinct documents don't all collapse to the same
    // `untitled.md` ref and silently overwrite each other. Path-aware: a
    // `guides/setup` slug keeps its `/` (per-segment slugging) instead of
    // mashing into `guidessetup`.
    const slug =
      slugifyPath(slugValue) || slugify(asString(doc._id) ?? "") || "untitled";

    const data: SanityFrontmatter = {};
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

    const body = getPath(doc, fields.body ?? "body");
    let markdown = "";
    // Serializer output is MDX (components, directives), so a source with
    // serializers writes its Portable Text entries as `.mdx`.
    let format: "md" | "mdx" = writesMdx(options.serializers) ? "mdx" : "md";
    if (isStringValue(body)) {
      // A Markdown field passes through as `.md`, its unsafe links reduced to
      // their labels, as the other CMS sources do (see `documentEntry`).
      markdown = neutralizeUnsafeLinks(`${body.trimEnd()}\n`);
      format = "md";
    } else if (Array.isArray(body)) {
      // SAFETY: an array in the body field is Portable Text blocks; the
      // serializer tolerates malformed blocks.
      markdown = portableTextToMarkdown(body as PortableTextBlock[], {
        imageUrl: (block) => {
          // SAFETY: `asset` on an image block is Sanity's asset reference
          // object; any other shape yields no `_ref` and the image is
          // skipped.
          const ref = (block.asset as { _ref?: string } | undefined)?._ref;
          return ref
            ? imageUrlFromRef(ref, options.projectId, options.dataset)
            : null;
        },
        serializers: options.serializers,
      });
    }
    const raw = matter.stringify(markdown, data);
    return {
      body: { format, text: markdown },
      // Spread into a fresh literal: `SourceEntry.data` wants an
      // index-signature type, which the named interface lacks.
      data: { ...data },
      hash: hashText(raw),
      lastModified: asString(getPath(doc, fields.lastModified ?? "_updatedAt")),
      raw,
      ref: `${slug}.${format}`,
    };
  };

  const load = async (
    refresh = ctx?.refresh ?? true
  ): Promise<SourceLoadResult> => {
    const empty: Diagnostic[] = [];
    const result = await loadWithCache(
      options.name,
      cache,
      async () => {
        const client = resolveClient(options, ctx?.preview ?? false);
        const docs = await client.fetch<SanityDocument[]>(options.query);
        // A private dataset answers a query without a token with no
        // documents rather than an error, so an empty result is the only
        // sign the token is missing.
        if (docs.length === 0 && !(options.token ?? process.env.SANITY_TOKEN)) {
          empty.push({
            code: "BLUME_MISSING_SECRET",
            message: `Source "${options.name}" found no documents, and SANITY_TOKEN is not set. A private dataset returns nothing to a query without a token.`,
            severity: "warning",
            suggestion:
              "Set SANITY_TOKEN to a token with read access if the dataset is private.",
          });
        }
        return docs.map(toEntry);
      },
      refresh
    );
    snapshot = new Map(result.entries.map((entry) => [entry.ref, entry]));
    return { ...result, diagnostics: [...result.diagnostics, ...empty] };
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
      ? pollingWatch(
          () => load(true),
          options.pollInterval,
          () => load()
        )
      : undefined,
    withContext: (next) => sanitySource(options, next),
  };
};
