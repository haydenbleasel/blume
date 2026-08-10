// html-escaper's five-entity table is XML-safe (`'` → the numeric `&#39;`).
import { escape as escapeXml } from "html-escaper";

import {
  customStaticRoutes,
  discoverPagesSync,
  hasGeneratedChangelog,
} from "../astro/pages.ts";
import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { siteRoot } from "../core/site-url.ts";

/**
 * Astro's reserved error routes. A user-authored override (`pages/404.astro`,
 * `pages/500.astro`, or a `404.md` content page — see `writeNotFoundPage` in
 * `astro/generate.ts`) is neither dynamic nor private, so it would otherwise
 * be emitted — but error pages aren't crawlable destinations and must stay out
 * of the sitemap.
 */
const ERROR_ROUTES = new Set(["/404", "/500"]);

/** A `<lastmod>` element (W3C date) when the page has a valid modified date. */
const lastmodTag = (value: string | undefined): string => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : `<lastmod>${date.toISOString().slice(0, 10)}</lastmod>`;
};

/** One emitted sitemap artifact: its dist-root filename and XML body. */
export interface SitemapFile {
  name: string;
  xml: string;
}

/**
 * The sitemaps.org cap on `<url>` entries in a single file. Beyond it,
 * `sitemap.xml` becomes a sitemap index pointing at numbered chunk files —
 * search engines reject an oversized urlset outright.
 */
const URLS_PER_FILE = 50_000;

const renderUrlset = (
  urls: string[]
): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;

/**
 * Build the sitemap files from the route manifest plus the routes the manifest
 * can't see: custom `.astro` pages (most importantly a custom landing `/`) and
 * the generated `/changelog` index. Returns null when the sitemap is disabled
 * or no `site` is configured (absolute URLs are required for a valid sitemap).
 * Drafts, hidden, and `noindex` pages are excluded.
 *
 * Sites within the per-file URL cap get the single classic `sitemap.xml`;
 * larger sites get `sitemap.xml` as a sitemap index over numbered
 * `sitemap-N.xml` chunks, all served from the same directory robots.txt
 * already points at.
 */
export const buildSitemapFiles = (
  project: BlumeProject
): SitemapFile[] | null => {
  const { site } = project.config.deployment;
  if (!(site && project.config.seo.sitemap)) {
    return null;
  }

  const base = siteRoot(site);
  // Routes carry `basePath`; a `deployment.base` subdirectory is layered on top.
  const deployBase = normalizeBasePath(project.config.deployment.base);

  // Archived-version pages leave the sitemap when the version is noindexed,
  // or when their canonical points at a still-existing latest equivalent —
  // listing a URL whose canonical says "index the other page" invites the
  // noindexed-page-in-sitemap incoherence Docusaurus is known for. A page
  // that exists only in an archived version stays listed (self-canonical).
  const { versions } = project.config;
  const archivedById = new Map(
    (versions?.archived ?? []).map((version) => [version.id, version])
  );
  const currentKeys = versions
    ? new Set(
        project.graph.pages.flatMap((page) =>
          page.version === "" ? [`${page.versionKey}\u0000${page.locale}`] : []
        )
      )
    : null;
  const archivedExcluded = (page: (typeof project.graph.pages)[number]) => {
    if (!page.version) {
      return false;
    }
    // A non-empty version always names a configured archived entry — that is
    // the only way detection assigns one.
    const archived = archivedById.get(page.version);
    return Boolean(
      archived?.noindex ||
      (archived?.canonical === "latest" &&
        currentKeys?.has(`${page.versionKey}\u0000${page.locale}`))
    );
  };

  const seen = new Set<string>();
  const urls: string[] = [];
  const pushUrl = (route: string, lastModified?: string): void => {
    // `<loc>` must be a well-formed, XML-escaped URL: percent-encode the path,
    // then escape XML metacharacters (notably `&`) so a route like
    // `/Tips & Tricks` doesn't produce invalid XML that gets the whole sitemap
    // rejected.
    const loc = escapeXml(encodeURI(`${base}${route}`));
    if (seen.has(loc)) {
      return;
    }
    seen.add(loc);
    urls.push(`  <url><loc>${loc}</loc>${lastmodTag(lastModified)}</url>`);
  };
  for (const page of project.graph.pages) {
    if (
      page.meta.draft ||
      page.meta.sidebar.hidden ||
      page.meta.seo.noindex ||
      ERROR_ROUTES.has(page.route) ||
      archivedExcluded(page)
    ) {
      continue;
    }
    pushUrl(withBasePath(deployBase, page.route), page.lastModified);
  }
  // Custom `.astro` pages and the generated changelog index mount outside
  // `basePath` (they're injected at their pattern — see `blumeIntegration`), so
  // only the deployment base layers onto their URLs.
  const userPages = project.context.pagesRoot
    ? discoverPagesSync(project.context.pagesRoot)
    : [];
  const extraRoutes = customStaticRoutes(userPages).filter(
    (route) => !ERROR_ROUTES.has(route)
  );
  if (hasGeneratedChangelog(project, userPages)) {
    extraRoutes.push("/changelog");
  }
  for (const route of extraRoutes) {
    pushUrl(withBasePath(deployBase, route));
  }
  urls.sort();

  if (urls.length <= URLS_PER_FILE) {
    return [{ name: "sitemap.xml", xml: renderUrlset(urls) }];
  }

  const chunks: SitemapFile[] = [];
  const references: string[] = [];
  for (let start = 0; start < urls.length; start += URLS_PER_FILE) {
    const name = `sitemap-${chunks.length + 1}.xml`;
    chunks.push({
      name,
      xml: renderUrlset(urls.slice(start, start + URLS_PER_FILE)),
    });
    // Chunks sit next to sitemap.xml, so their URLs layer the same deployment
    // base robots.txt uses for the index.
    const loc = escapeXml(
      encodeURI(`${base}${withBasePath(deployBase, `/${name}`)}`)
    );
    references.push(`  <sitemap><loc>${loc}</loc></sitemap>`);
  }
  const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${references.join("\n")}
</sitemapindex>
`;
  return [{ name: "sitemap.xml", xml: index }, ...chunks];
};
