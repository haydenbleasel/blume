import type {
  FolderMeta,
  FrontmatterExtend,
  ResolvedI18nConfig,
  ResolvedVersionsConfig,
} from "../schema.ts";
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
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- pre-validation frontmatter from YAML/CMS payloads; the meta schema parses it downstream
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
   * Absolute filesystem path when the entry originates from disk. Set by any
   * local-file adapter — the filesystem source, and staged local sources such
   * as Obsidian, whose bodies are rewritten but whose notes are still real
   * files. It gives diagnostics a path the author recognizes and lets relative
   * image checks resolve next to the file. Omitted by remote/CMS adapters.
   *
   * It does *not* imply the entry renders through the docs glob collection —
   * read `source.staged` for that — and git last-modified additionally needs
   * the owning source to expose a `contentRoot` to bound the log's pathspec.
   */
  sourcePath?: string;
  /** Optional provenance for "edit this page". */
  editUrl?: string;
  /** Optional last-modified ISO date supplied by the adapter (non-filesystem). */
  lastModified?: string;
  /** Content hash for cache invalidation / HMR; adapter-computed when cheap. */
  hash?: string;
  /**
   * The body with `<include>` statements expanded, set by the scan's expansion
   * pass (filesystem entries whose body contains a statement). `normalizeEntry`
   * extracts headings/links/components from this text so a partial's content
   * counts toward the including page, with `origins` mapping each expanded
   * line back to the file and raw line it came from for diagnostics.
   */
  expanded?: {
    text: string;
    origins: { file: string; line: number }[];
    /** Absolute paths of every file included, transitively. */
    includes: string[];
  };
}

/** The result of a single `ContentSource.load()` call. */
export interface SourceLoadResult {
  entries: SourceEntry[];
  /** Source-level diagnostics (e.g. an offline cache fallback warning). */
  diagnostics: Diagnostic[];
  /**
   * Folder meta the source derives for the sidebar groups its entries create,
   * keyed by locale-stripped group path (the `meta.ts` key space). The OpenAPI
   * source labels each tag directory with the spec's own tag name, so the
   * sidebar shows `OAuth2`/`Größe` instead of a re-humanized slug. Merged
   * beneath user-authored meta files, which always win.
   */
  folderMeta?: Record<string, FolderMeta>;
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
  /**
   * Resolved on-disk root, set by sources whose entries live on disk. For
   * filesystem sources it drives folder-meta discovery (scan under this root)
   * and the docs-collection base; for staged local sources (an Obsidian
   * vault) it only bounds the git last-modified pathspec — folder-meta
   * discovery is guarded on `staged`. Omitted by remote/CMS sources that have
   * no local tree.
   */
  readonly contentRoot?: string;
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
  /** Site-wide route mount point (`""` or `/seg`), prepended to every route. */
  basePath?: string;
  defaultType: string;
  /** Opt-in custom frontmatter keys (`frontmatter.extend`), schema per key. */
  frontmatterExtend?: FrontmatterExtend;
  i18n?: ResolvedI18nConfig;
  /**
   * Per-type custom frontmatter keys (`content.types.<type>.frontmatter`),
   * applied to a page only when its resolved `type` matches.
   */
  typeFrontmatter?: Record<string, FrontmatterExtend>;
  /** Docs versioning config; a leading archived-version dir becomes the page's version. */
  versions?: ResolvedVersionsConfig;
}
