import type { BlumeProject } from "../core/project-graph.ts";
import type {
  Diagnostic,
  DiagnosticSeverity,
  RouteManifestEntry,
} from "../core/types.ts";

/**
 * What a check needs in order to run. Anything above `static` is opt-in, and a
 * skipped tier is reported rather than silently omitted — a crawler that
 * quietly doesn't check something is worse than one that says it didn't.
 */
export type AuditTier = "static" | "network" | "external";

export type AuditCategory =
  | "content"
  | "duplicates"
  | "indexability"
  | "links"
  | "redirects"
  | "social"
  | "i18n"
  | "assets"
  | "sitemap"
  | "robots"
  | "structured-data"
  | "ai"
  | "network";

/** A check's static metadata. The catalog is the source of truth for all of it. */
export interface CheckMeta {
  readonly id: string;
  readonly category: AuditCategory;
  readonly severity: DiagnosticSeverity;
  /** Human title used as the report's group header, e.g. "Title too long". */
  readonly title: string;
  readonly tier: AuditTier;
  /** Default remediation, used as the finding's `suggestion`. */
  readonly fix?: string;
}

/** A `<link>`/`<a>` discovered in built HTML. */
export interface SnapshotLink {
  href: string;
  rel: string | null;
  text: string;
  /**
   * Whether the link sits in the page's prose (`<main>`/`<article>`) rather
   * than site chrome (nav/sidebar/header/footer). Load-bearing: Blume's sidebar
   * links every page from every page, so a link graph that can't tell the two
   * apart reports zero orphans, forever.
   */
  content: boolean;
}

/** An image/script/stylesheet referenced by a built page. */
export interface SnapshotAsset {
  src: string;
  alt?: string | null;
  width?: string | null;
  height?: string | null;
  /** Absolute path in the static dir, when the ref resolves to a local file. */
  file?: string;
  bytes?: number;
}

/** Everything one built HTML page contributes to the audit. */
export interface PageSnapshot {
  /** Absolute path of the built `.html`. */
  file: string;
  /** Site-root-relative URL, e.g. `/docs/getting-started`. */
  url: string;
  bytes: number;
  /** The manifest entry this page renders, when it maps to authored content. */
  route?: RouteManifestEntry;
  /** `route.sourcePath` — the `.mdx` a finding should point the user at. */
  source?: string;
  indexable: boolean;

  lang: string | null;
  /** Every `<title>`; more than one is itself a finding. */
  titles: string[];
  descriptions: string[];
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  metaRefresh: string | null;
  headings: { depth: number; text: string }[];
  og: Record<string, string>;
  twitter: Record<string, string>;
  hreflang: { lang: string; href: string }[];
  jsonld: unknown[];
  /** JSON-LD blocks that failed to parse, with the parser's message. */
  jsonldErrors: string[];
  links: SnapshotLink[];
  images: SnapshotAsset[];
  scripts: SnapshotAsset[];
  styles: SnapshotAsset[];
  wordCount: number;
  /** Hash of the normalized prose, for exact-duplicate detection. */
  contentHash: string;
  /** Every element `id` on the page — the targets `#fragment` links can hit. */
  ids: Set<string>;
}

/** A configured redirect resolved through to its final destination. */
export interface RedirectResolution {
  from: string;
  to: string;
  status: number;
  /** Every hop from `from` to the final target, inclusive. */
  chain: string[];
  outcome: "ok" | "loop" | "broken" | "chain";
}

/** A parsed `sitemap.xml`. */
export interface SitemapDoc {
  file: string;
  bytes: number;
  /** Absolute `<loc>` URLs, in document order. */
  urls: string[];
  /** Each `<url>` block's `<lastmod>`, keyed by its `<loc>`. */
  lastmod?: Map<string, string>;
  /** Parse failure, when the document isn't usable. */
  error?: string;
}

/** A parsed `llms.txt` index. */
export interface LlmsDoc {
  file: string;
  /** Markdown link targets in document order, with their 1-based line. */
  entries: { url: string; line: number }[];
}

/** A parsed `robots.txt`. */
export interface RobotsDoc {
  file: string;
  /** `Disallow:` paths for `User-agent: *`. */
  disallow: string[];
  /** `Sitemap:` declarations. */
  sitemaps: string[];
  /** Lines that aren't a recognized directive, with their 1-based line number. */
  invalid: { line: number; text: string }[];
}

/** Incoming/outgoing internal-link edges, split by where the link sits. */
export interface LinkGraph {
  /** url -> urls it links to from its prose. */
  contentOut: Map<string, Set<string>>;
  /** url -> urls whose prose links to it. */
  contentIn: Map<string, Set<string>>;
  /** url -> urls it links to from chrome (nav/sidebar/footer). */
  chromeOut: Map<string, Set<string>>;
  chromeIn: Map<string, Set<string>>;
}

/** Astro's reserved error routes. Never indexable, never crawlable — by design. */
export const ERROR_ROUTES: ReadonlySet<string> = new Set(["/404", "/500"]);

/** Tunable limits. Not yet configurable — CLI-only until the ids settle. */
export interface AuditThresholds {
  titleMin: number;
  titleMax: number;
  descriptionMin: number;
  descriptionMax: number;
  minWordCount: number;
  maxHtmlBytes: number;
  maxAssetBytes: number;
  maxRedirectHops: number;
}

export const DEFAULT_THRESHOLDS: AuditThresholds = {
  // Ahrefs' guidance: 110–160 characters. Under ~110 wastes the snippet
  // space search results give you; over ~160 gets truncated.
  descriptionMax: 160,
  descriptionMin: 110,
  maxAssetBytes: 500 * 1024,
  // Googlebot stops reading an HTML document at 2 MB.
  maxHtmlBytes: 2 * 1024 * 1024,
  maxRedirectHops: 3,
  minWordCount: 50,
  titleMax: 60,
  titleMin: 10,
};

/** Everything the check modules read. Assembled once per run. */
export interface AuditContext {
  project: BlumeProject;
  staticDir: string;
  /** Origin passed via `--url`, for the network tier. */
  origin: string | null;
  pages: PageSnapshot[];
  byUrl: Map<string, PageSnapshot>;
  /** Every file in the static dir: URL path -> size in bytes. */
  files: Map<string, number>;
  /**
   * Raw text of every page's source file, keyed by absolute path. Read once so
   * findings can be anchored to the exact front matter line that fixes them.
   */
  sources: Map<string, string>;
  graph: LinkGraph;
  redirects: RedirectResolution[];
  sitemap: SitemapDoc | null;
  robots: RobotsDoc | null;
  llms: LlmsDoc | null;
  thresholds: AuditThresholds;
}

/** One category's checks. Modules, not per-check closures — see catalog.ts. */
export interface CheckModule {
  readonly category: AuditCategory;
  readonly tier: AuditTier;
  readonly run: (context: AuditContext) => Diagnostic[] | Promise<Diagnostic[]>;
}
