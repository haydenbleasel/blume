import type { ResolvedI18nConfig } from "../schema.ts";
import type { Diagnostic } from "../types.ts";

/**
 * A single content item, normalized by a source adapter. Adapters lower their
 * native shape (files, Portable Text, Notion blocks, remote HTML) to Markdown/MDX
 * *text* so Blume's markdown processors and component set apply uniformly.
 */
export interface SourceEntry {
  /** Source-local stable id, e.g. `api/auth.mdx` or a CMS document id. */
  ref: string;
  /** Logical route input; defaults to `ref` if omitted. May include slashes. */
  slug?: string;
  /** Frontmatter-equivalent metadata, validated against the Blume meta schema. */
  data: Record<string, unknown>;
  /** The renderable body as Markdown/MDX source text (frontmatter stripped). */
  body: { format: "md" | "mdx"; text: string };
  /**
   * Full source text including frontmatter, written verbatim to the staging
   * dir so Astro re-parses the same frontmatter. Staged (non-filesystem) sources
   * set this; filesystem entries (read from disk) omit it.
   */
  raw?: string;
  /**
   * Absolute filesystem path when the entry originates from disk. Populated by
   * the filesystem adapter only; powers git last-modified and edit URLs and the
   * `sourcePath` back-compat window. Omitted by remote/CMS adapters.
   */
  sourcePath?: string;
  /** Optional provenance for "edit this page". */
  editUrl?: string;
  /** Optional last-modified ISO date supplied by the adapter (non-filesystem). */
  lastModified?: string;
  /** Content hash for cache invalidation / HMR; adapter-computed when cheap. */
  hash?: string;
}

/** The result of a single `ContentSource.load()` call. */
export interface SourceLoadResult {
  entries: SourceEntry[];
  /** Source-level diagnostics (e.g. an offline cache fallback warning). */
  diagnostics: Diagnostic[];
}

/**
 * Per-source runtime context, handed to an adapter factory at construction so
 * `load`/`read`/`watch` can close over it without re-threading on every call.
 */
export interface SourceContext {
  projectRoot: string;
  /** Per-source cache dir under `.blume/cache/<source>/`. */
  cacheDir: string;
  mode: "dev" | "build";
  /** Dir for downloaded assets (served from the site's public dir). */
  assetsDir?: string;
  /** Public URL prefix the downloaded assets are served under. */
  assetsBaseUrl?: string;
  /**
   * Re-fetch remote content instead of serving the cached snapshot. True for
   * builds and `blume sync`; false in dev (cache-first for fast, offline-tolerant
   * restarts — refresh with `blume sync` or an opt-in `pollInterval`).
   */
  refresh?: boolean;
  /**
   * Preview unpublished content: drafts are kept and CMS adapters fetch draft
   * documents (Sanity's `previewDrafts` perspective). Off for production builds.
   */
  preview?: boolean;
}

/**
 * A pluggable content source. Adapters enumerate normalized entries and
 * (optionally) re-read a single entry, validate themselves, and watch for
 * changes. Identity is the opaque `SourceEntry.ref`, never a filesystem path.
 */
export interface ContentSource {
  /** Unique, stable name; used for id namespacing and diagnostics. */
  readonly name: string;
  /**
   * Whether entries render through the staging collection. Filesystem sources
   * render through Astro's existing `docs` glob collection (`false`); every
   * other source materializes MDX into `.blume/content` (`true`).
   */
  readonly staged: boolean;
  /** Optional route prefix; the source's routes namespace under `/<prefix>/`. */
  readonly prefix?: string;
  /** Pull every entry. Called once per scan. */
  load: () => Promise<SourceLoadResult>;
  /** Validate the source is usable; throws a BlumeError when not. */
  validate?: () => void;
  /** Read a single entry's body lazily (search / AI / raw export). */
  read?: (ref: string) => Promise<string>;
  /**
   * Notify on change in dev. Returns a disposer. Filesystem uses `fs.watch`;
   * remote/static sources omit it (content is frozen for the session).
   */
  watch?: (onChange: () => void) => () => void;
}

/** Context passed to `normalizeEntry`, describing the owning source. */
export interface NormalizeContext {
  source: { name: string; prefix?: string; staged: boolean };
  defaultType: string;
  i18n?: ResolvedI18nConfig;
}
