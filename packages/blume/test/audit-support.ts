import { buildGraph } from "../src/audit/graph.ts";
import { resolveRedirects } from "../src/audit/redirects.ts";
import { DEFAULT_THRESHOLDS } from "../src/audit/types.ts";
import type {
  AuditContext,
  LlmsDoc,
  PageSnapshot,
  RobotsDoc,
  SitemapDoc,
} from "../src/audit/types.ts";
import { normalizePath, siteOrigin } from "../src/audit/url.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";

/** A page with everything a healthy Blume page has, so a test only sets the defect. */
export const snapshot = (
  partial: Partial<PageSnapshot> = {}
): PageSnapshot => ({
  bytes: 1000,
  canonical: null,
  contentHash: "hash",
  descriptions: [
    "A description that is comfortably long enough to pass the audit's length check, which wants at least a hundred and ten characters.",
  ],
  file: "/dist/index.html",
  headings: [{ depth: 1, text: "Heading" }],
  hreflang: [],
  ids: new Set<string>(),
  images: [],
  indexable: true,
  jsonld: [],
  jsonldErrors: [],
  lang: "en",
  links: [],
  metaRefresh: null,
  og: {
    "og:description": "d",
    "og:image": "https://x.dev/og.png",
    "og:title": "t",
    "og:type": "website",
    "og:url": "https://x.dev/",
  },
  robots: null,
  scripts: [],
  styles: [],
  titles: ["A reasonable title"],
  twitter: { "twitter:card": "summary_large_image" },
  url: "/",
  viewport: "width=device-width",
  wordCount: 500,
  ...partial,
});

interface ContextOptions {
  pages?: PageSnapshot[];
  adapter?: string;
  site?: string;
  redirects?: { from: string; to: string; status: number }[];
  sitemap?: SitemapDoc | null;
  robots?: RobotsDoc | null;
  llms?: LlmsDoc | null;
  llmsTxt?: boolean | { enabled: boolean; openapi: boolean };
  files?: Map<string, number>;
  sources?: Map<string, string>;
  seo?: { robots?: boolean; sitemap?: boolean };
  configFile?: string;
}

/** A minimal AuditContext. Only the config fields the checks read are populated. */
export const context = (options: ContextOptions = {}): AuditContext => {
  const pages = options.pages ?? [snapshot()];
  const redirects = options.redirects ?? [];
  const project = {
    config: {
      ai: { llmsTxt: options.llmsTxt ?? { enabled: true, openapi: true } },
      basePath: "",
      deployment: {
        adapter: options.adapter ?? null,
        base: undefined,
        site: options.site,
      },
      redirects,
      seo: {
        robots: options.seo?.robots ?? true,
        sitemap: options.seo?.sitemap ?? true,
      },
    },
    context: { configFile: options.configFile ?? null },
  } as unknown as BlumeProject;

  const byUrl = new Map(pages.map((page) => [page.url, page]));
  return {
    byUrl,
    files: options.files ?? new Map(),
    graph: buildGraph(pages, siteOrigin(options.site)),
    llms: options.llms ?? null,
    origin: null,
    pages,
    project,
    redirects: resolveRedirects(
      redirects,
      new Set([...byUrl.keys()].map(normalizePath))
    ),
    robots: options.robots ?? null,
    sitemap: options.sitemap ?? null,
    sources: options.sources ?? new Map(),
    staticDir: "/dist",
    thresholds: DEFAULT_THRESHOLDS,
  };
};

/** The check ids a module reported, for terse assertions. */
export const codes = (diagnostics: { code: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code.replace("BLUME_AUDIT_", ""));
