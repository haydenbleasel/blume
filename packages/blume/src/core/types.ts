import type { PageMeta, ResolvedConfig } from "./schema.ts";

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
  /** Stable id: content-root-relative path, e.g. `api/auth.mdx`. */
  id: string;
  /** Absolute source path. */
  sourcePath: string;
  /** URL route, e.g. `/api/auth`. Always starts with `/`. */
  route: string;
  /** Path segments without numeric prefixes, e.g. `["api", "auth"]`. */
  segments: string[];
  /** Group-folder labels this page lives under, e.g. `["guides"]`. */
  groups: string[];
  title: string;
  description?: string;
  contentType: string;
  meta: PageMeta;
  headings: Heading[];
  /** Whether the file is `.md`/`.mdx`. */
  format: "md" | "mdx";
  /** Internal/asset links discovered in the page (for validation). */
  links: PageLink[];
}

/** A node in the generated navigation tree. */
export type NavNode =
  | {
      kind: "page";
      label: string;
      route: string;
      icon?: string;
      badge?: string;
      pageId: string;
    }
  | {
      kind: "group";
      label: string;
      icon?: string;
      collapsed?: boolean;
      children: NavNode[];
    };

/** Top-level tab/section. */
export interface NavTab {
  label: string;
  path: string;
  icon?: string;
}

/** The complete navigation model derived from the content graph. */
export interface Navigation {
  tabs: NavTab[];
  sidebar: NavNode[];
}

/** The full content graph: the source of truth for generated modules. */
export interface ContentGraph {
  pages: PageRecord[];
  navigation: Navigation;
  /** Map of route -> pageId for fast lookup and duplicate detection. */
  routes: Map<string, string>;
  diagnostics: Diagnostic[];
}

/** A route entry written to `blume.manifest.json`. */
export interface RouteManifestEntry {
  id: string;
  path: string;
  sourcePath: string;
  title: string;
  contentType: string;
  hidden: boolean;
  draft: boolean;
  /** Whether the page should be included in the search index. */
  indexable: boolean;
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
