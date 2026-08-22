import type {
  DirectoryMode,
  PageMeta,
  ResolvedConfig,
  SidebarDisplay,
} from "./schema.ts";

/** Severity levels for Blume diagnostics. */
export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * A single actionable diagnostic. Diagnostics are printable in the CLI, the
 * Astro/Vite overlay, and as JSON for editor integrations.
 */
export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /**
   * The built URL this diagnostic is about, for findings that are a property of
   * the output rather than of a source file (`blume audit`). Set alongside
   * `file`/`line` where the page maps back to authored content, so a finding can
   * name both the URL that's wrong and the frontmatter line that fixes it.
   */
  url?: string;
  schemaPath?: string;
  suggestion?: string;
  docsUrl?: string;
}

/** One discovered `examples/` file reduced to what Markdown downleveling needs. */
export interface ExampleMarkdownEntry {
  /** Shiki language for the fenced block — the file's extension. */
  lang: string;
  /** Raw example source, shown verbatim in the agent-facing code fence. */
  source: string;
}

/**
 * Discovered examples keyed by their `<Component path>` (the file's location
 * under `examples/`, sans extension). Lets the agent-facing Markdown downlevel
 * `<Component path="…" />` to the example's source, since the live preview
 * can't survive the trip to plain Markdown.
 */
export type ExampleLookup = Record<string, ExampleMarkdownEntry>;

/** A heading extracted from page content, used for the TOC and search. */
export interface Heading {
  depth: number;
  text: string;
  slug: string;
}

/** A link target discovered in page content, anchored to its source line. */
export interface PageLink {
  /** Raw link target as written, e.g. `./foo`, `/api#auth`, `https://x.dev`. */
  target: string;
  /** Set when the target was written as an image embed (`![alt](target)`) —
   * only those go through the image pipeline; a plain link to the same path
   * resolves as a site route. */
  image?: boolean;
  /** 1-based line number in the source file. */
  line: number;
  /** 1-based column of the target within the line. */
  column: number;
  /** Absolute path of the file the link was written in, when that isn't the
   * page's own source — a link inside an included partial. Diagnostics point
   * here so authors fix the partial, not the page that spliced it. */
  file?: string;
}

/**
 * Resolved project paths. Computed once per CLI invocation and threaded
 * through the core pipeline.
 */
export interface ProjectContext {
  /** Absolute path to the user project root. */
  root: string;
  /** Absolute path to the content root (e.g. `<root>/docs`). */
  contentRoot: string;
  /** Absolute path to the custom pages dir, if it exists. */
  pagesRoot: string | null;
  /** Absolute path to the generated runtime (`<root>/.blume`). */
  outDir: string;
  /**
   * Absolute path to the Astro build output. `<root>/dist` normally; for a
   * relocated runtime (isolated verify build) it lives under the runtime dir so
   * it never empties the real `dist/`. Optional so hand-built test contexts and
   * older callers still typecheck; `resolveProjectContext` always sets it.
   */
  distDir?: string;
  /** Absolute path to the user `theme.css`, if present. */
  themeFile: string | null;
  /** Absolute path to the user `components.ts`/`.tsx`, if present. */
  componentsFile: string | null;
  /** Absolute path to the resolved config file, if any was found. */
  configFile: string | null;
}

/**
 * A normalized content page. This is the unit the route manifest, nav graph,
 * and search index are derived from.
 */
export interface PageRecord {
  /** Stable, globally-unique id: `"<source>:<ref>"`, e.g. `filesystem:api/auth.mdx`. */
  id: string;
  /** Provenance: the owning source's name and its source-local ref. */
  source: { name: string; ref: string };
  /** Absolute source path. Populated by any local-file adapter (back-compat). */
  sourcePath?: string;
  /**
   * Renderable body captured at scan time. Set for staged (non-filesystem)
   * sources so they can be materialized to `.blume/content` and so soft
   * consumers need no re-read; omitted for filesystem entries (read from disk).
   */
  body?: { format: "md" | "mdx"; text: string };
  /** Adapter-supplied "edit this page" URL (non-filesystem sources). */
  editUrl?: string;
  /** Astro collection this entry renders through; defaults to `"docs"`. */
  collection?: string;
  /** Astro collection-relative entry id for `getEntry`; defaults to the ref. */
  entryId?: string;
  /** URL route, e.g. `/api/auth`. Always starts with `/`. Locale-prefixed under i18n. */
  route: string;
  /** Resolved locale code; the default locale when not under i18n. */
  locale: string;
  /**
   * Locale-agnostic logical route shared by every translation (e.g.
   * `/guides/x`, or `/v1.0/guides/x` under versioning — the key is
   * version-specific, so translations group within their version).
   * Pages with the same key are translations of each other.
   */
  translationKey: string;
  /**
   * Resolved docs version: an archived id (`v1.0`) for snapshot pages, `""`
   * for the current (unprefixed) docs — including every page of an
   * unversioned project.
   */
  version: string;
  /**
   * Version- and locale-agnostic logical route (e.g. `/guides/x` for
   * `/v1.0/guides/x`). Pages with the same key and locale are the same
   * logical page across versions — this drives the switcher's same-page
   * navigation and the canonical-to-latest lookup.
   */
  versionKey: string;
  /**
   * True for entries filled in from the fallback locale to pad a locale's
   * navigation for pages it hasn't translated yet. The record's content —
   * title included — belongs to the fallback locale, so per-locale content
   * checks skip these.
   */
  fallback?: boolean;
  /**
   * Content-relative path with the leading locale directory stripped, used for
   * sidebar grouping so the locale dir is not surfaced as a nav group. Equals
   * `id` for single-locale projects.
   */
  navPath: string;
  /** Path segments without numeric prefixes, e.g. `["api", "auth"]`. */
  segments: string[];
  /** Group-folder labels this page lives under, e.g. `["guides"]`. */
  groups: string[];
  title: string;
  description?: string;
  contentType: string;
  meta: PageMeta;
  /**
   * Custom frontmatter values declared via `frontmatter.extend` or the page
   * type's `content.types.<type>.frontmatter`, validated by the user-supplied
   * schemas (schema output, so transforms apply). Present only when the
   * project opts in and the page carries at least one value.
   */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- values are outputs of arbitrary user-supplied zod schemas (transforms included), so no narrower type exists
  custom?: Record<string, unknown>;
  headings: Heading[];
  /** Whether the file is `.md`/`.mdx`. */
  format: "md" | "mdx";
  /** Internal/asset links discovered in the page (for validation). */
  links: PageLink[];
  /** Capitalized JSX component tags used in the body (`.mdx` only). */
  componentsUsed?: string[];
  /** Resolved "last updated" ISO date, when the feature is enabled. */
  lastModified?: string;
  /** Absolute paths of files this page `<include>`s, transitively. Drives the
   * dev-server invalidation edge from a partial to the pages that splice it. */
  includes?: string[];
}

/** A node in the generated navigation tree. */
export type NavNode =
  | {
      kind: "page";
      label: string;
      route: string;
      description?: string;
      icon?: string;
      badge?: string;
      deprecated?: boolean;
      pageId: string;
    }
  | {
      kind: "group";
      label: string;
      badge?: string;
      directory?: DirectoryMode;
      /**
       * The group's resolved render mode. Always stamped by both builders
       * (generated and explicit-config sidebars), so the renderer can rely
       * on it per node.
       */
      display: SidebarDisplay;
      icon?: string;
      route?: string;
      /**
       * The group's URL path (its folder route prefix), even when the folder
       * has no index page to link. Used to scope the sidebar to a tab's section;
       * not a clickable link (that's `route`).
       */
      path?: string;
      collapsed?: boolean;
      children: NavNode[];
    };

/** Top-level tab/section. */
export interface NavTab {
  label: string;
  /**
   * The tab's section prefix, used to scope the sidebar and match the active
   * tab. Not necessarily a linkable route — a section may have no index page.
   */
  path: string;
  /**
   * The clickable target. Author-declared when the config sets it; otherwise
   * equals `path` when the section has an index page, and resolves to the
   * section's first page when it doesn't, so the tab doesn't link to a 404 as
   * long as the section has a page to offer — a section with no linkable page at
   * all keeps `path`. Absent when a resolved target matches `path`.
   */
  href?: string;
  icon?: string;
  items?: NavSelectorItem[];
}

/** A selectable navigation option inside a tab menu or top selector. */
export interface NavSelectorItem {
  label: string;
  path: string;
  description?: string;
  icon?: string;
  tag?: string;
}

/** Context-partition selector kinds (a versioned/localized/multi-product site). */
type NavSelectorContextKind = "product" | "version";
/** What a top-level partition selector switches between. */
type NavSelectorKind = "dropdown" | "language" | NavSelectorContextKind;

/** Top-level partition selectors (products, versions, languages). */
export interface NavSelector {
  label: string;
  kind: NavSelectorKind;
  items: NavSelectorItem[];
}

/** A pinned link rendered above the sidebar sections (external or internal). */
export interface FeaturedLink {
  label: string;
  href: string;
  icon?: string;
}

/** The complete navigation model derived from the content graph. */
export interface Navigation {
  tabs: NavTab[];
  selectors: NavSelector[];
  sidebar: NavNode[];
  /**
   * The tree root in final path space — localized and based (`/`, `/en`,
   * `/docs`), and versionized for an archived version tree (`/v1.0`). Tab
   * paths share that space except under a version, where they stay in
   * current-docs space — so the root tab is the tab this root sits under
   * (`isRootTab`), not necessarily the tab at this exact path, and must be
   * scoped as the root tab, not as a section tab. Absent on older serialized
   * graphs; treat as `/`.
   */
  root?: string;
  /** Pinned links shown above the sidebar sections, unscoped by tab. */
  featured: FeaturedLink[];
  /** Repo URL for the header link, or null when hidden (`navigation.repo`). */
  repoUrl?: string | null;
}

/** The full content graph: the source of truth for generated modules. */
export interface ContentGraph {
  pages: PageRecord[];
  /** Default-locale navigation (the whole site when not under i18n). */
  navigation: Navigation;
  /** Navigation per locale; one entry per configured locale under i18n. */
  navigationByLocale: Record<string, Navigation>;
  /**
   * Navigation per archived version, keyed by version id and then locale code
   * (`""` on a single-locale site). The current version's trees are
   * `navigation`/`navigationByLocale`; empty when versioning is off.
   */
  navigationByVersion: Record<string, Record<string, Navigation>>;
  /** Map of route -> pageId for fast lookup and duplicate detection. */
  routes: Map<string, string>;
  diagnostics: Diagnostic[];
}

/** A locale a logical page exists in, for the switcher and `hreflang`. */
export interface RouteAlternate {
  locale: string;
  path: string;
}

/** A resolved language-switcher entry for the current page. */
export interface LocaleSwitchOption {
  code: string;
  label: string;
  dir: "ltr" | "rtl";
  /** Target URL: the real translation, or the localized fallback URL. */
  href: string;
  current: boolean;
  /** True when this locale has no real translation (renders fallback content). */
  untranslated: boolean;
}

/** A docs version a logical page exists in, for the switcher and canonicals. */
export interface VersionAlternate {
  /** Version id; `""` for the current (unprefixed) docs. */
  version: string;
  path: string;
}

/** A route entry written to `blume.manifest.json`. */
export interface RouteManifestEntry {
  id: string;
  /** Provenance: the owning source's name and its source-local ref. */
  source: { name: string; ref: string };
  /** Astro collection this entry renders through (`"docs"` | `"staged"`). */
  collection: string;
  /** Astro collection-relative entry id, passed to `getEntry`. */
  entryId: string;
  path: string;
  /** Absolute source path; populated for local-file entries only (back-compat). */
  sourcePath?: string;
  /** Adapter-supplied "edit this page" URL (non-filesystem sources). */
  editUrl?: string;
  title: string;
  contentType: string;
  hidden: boolean;
  draft: boolean;
  /** Whether the page should be included in the search index. */
  indexable: boolean;
  /** Resolved locale code; the default locale when not under i18n. */
  locale: string;
  /** Locales this logical page is genuinely translated into (excludes fallbacks). */
  alternates: RouteAlternate[];
  /** Resolved docs version (`""` for the current docs; see `PageRecord.version`). */
  version: string;
  /**
   * Versions this logical page exists in within this route's locale — the
   * current version first, then archived versions in configured order. Drives
   * the switcher's same-page navigation and the canonical-to-latest lookup.
   * Empty when versioning is off.
   */
  versionAlternates: VersionAlternate[];
  /** True when this route renders fallback content for a missing translation. */
  fallback?: boolean;
  /** Resolved "last updated" ISO date, when the feature is enabled. */
  lastModified?: string;
}

/** The generated runtime contract between core and the Astro project. */
export interface BlumeManifest {
  version: number;
  blumeVersion: string;
  projectRoot: string;
  contentRoot: string;
  output: ResolvedConfig["deployment"]["output"];
  routes: RouteManifestEntry[];
}
