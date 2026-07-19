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
  /** 1-based line number in the source file. */
  line: number;
  /** 1-based column of the target within the line. */
  column: number;
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
  /** Absolute source path. Populated by the filesystem adapter only (back-compat). */
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
   * `/guides/x`). Pages with the same key are translations of each other.
   */
  translationKey: string;
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
   * Custom frontmatter values declared via `frontmatter.extend`, validated by
   * the user-supplied schemas (schema output, so transforms apply). Present
   * only when the project opts in and the page carries at least one value.
   */
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
      display?: SidebarDisplay;
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
   * The clickable target. Equals `path` when the section has an index page;
   * otherwise it's resolved to the section's first page so the tab never links
   * to a 404. Absent when it matches `path`.
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
  /** Absolute source path; populated for filesystem entries only (back-compat). */
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
