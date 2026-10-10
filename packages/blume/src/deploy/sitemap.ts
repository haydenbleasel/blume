// html-escaper's five-entity table is XML-safe (`'` → the numeric `&#39;`).
import { escape as escapeXml } from "html-escaper";

import {
  customStaticRoutes,
  discoverPagesSync,
  hasGeneratedChangelog,
} from "../astro/pages.ts";
import {
  mountBasePath,
  normalizeBasePath,
  normalizePath,
} from "../core/base-path.ts";
import { isHiddenPage } from "../core/hidden-pages.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { siteRoot } from "../core/site-url.ts";
import type { RouteAlternate } from "../core/types.ts";

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

/**
 * Whether a page's own `seo.canonical` names another URL. The sitemap lists
 * canonical URLs only, so such a page stays out — `blume audit` reports a
 * listed one as NON_CANONICAL_IN_SITEMAP and expects it unlisted. Compared by
 * decoded path, as the audit does: `served` is the page's path with the
 * deployment base mounted, which the canonical carries too.
 */
const canonicalElsewhere = (
  canonical: string | undefined,
  served: string
): boolean => {
  if (!canonical) {
    return false;
  }
  const { pathname } = new URL(canonical);
  let path = pathname;
  try {
    path = decodeURI(pathname);
  } catch {
    // A malformed escape stays as written; it can't match the served path.
  }
  return normalizePath(path) !== normalizePath(served);
};

/** One emitted sitemap artifact: its dist-root filename and XML body. */
export interface SitemapFile {
  name: string;
  xml: string;
}

/** The build log line for an emitted sitemap set: one file, or an index. */
export const describeSitemapFiles = (files: readonly SitemapFile[]): string =>
  files.length === 1
    ? "Generated sitemap.xml"
    : `Generated sitemap.xml (index of ${files.length - 1} sitemap files)`;

/**
 * The sitemaps.org cap on `<url>` entries in a single file. Beyond it,
 * `sitemap.xml` becomes a sitemap index pointing at numbered chunk files —
 * search engines reject an oversized urlset outright.
 */
const URLS_PER_FILE = 50_000;

const renderUrlset = (
  urls: string[],
  alternatesEnabled: boolean
): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${alternatesEnabled ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ""}>
${urls.join("\n")}
</urlset>
`;

/**
 * The content pages crawlers may index under their own URL: drafts, hidden,
 * `noindex` (the page's or its archived version's), and error pages can't, nor
 * can a page whose own `seo.canonical` names another URL.
 */
const indexablePages = (
  project: BlumeProject
): BlumeProject["graph"]["pages"] => {
  const deployBase = normalizeBasePath(project.config.deployment.options.base);
  // A non-empty version always names a configured archived entry — that is
  // the only way detection assigns one.
  const noindexVersions = new Set(
    (project.config.versions?.archived ?? []).flatMap((version) =>
      version.noindex ? [version.id] : []
    )
  );
  return project.graph.pages.filter(
    (page) =>
      !page.meta.draft &&
      !isHiddenPage(page, project.graph) &&
      !page.meta.seo.noindex &&
      !noindexVersions.has(page.version) &&
      !ERROR_ROUTES.has(page.route) &&
      !canonicalElsewhere(
        page.meta.seo.canonical,
        mountBasePath(deployBase, page.route)
      )
  );
};

/**
 * The content pages the sitemap lists: the indexable ones, less archived-version
 * pages whose canonical points at a still-existing latest equivalent —
 * listing a URL whose canonical says "index the other page" invites the
 * noindexed-page-in-sitemap incoherence Docusaurus is known for. A page that
 * exists only in an archived version stays listed (self-canonical), and a
 * page's own `seo.canonical` wins over the version's default, as it does in
 * the page head (see `canonicalElsewhere`).
 */
const listedPages = (project: BlumeProject): BlumeProject["graph"]["pages"] => {
  const latestVersions = new Set(
    (project.config.versions?.archived ?? []).flatMap((version) =>
      version.canonical === "latest" ? [version.id] : []
    )
  );
  const currentKeys = new Set(
    project.graph.pages.flatMap((page) =>
      page.version === "" ? [`${page.versionKey}\u0000${page.locale}`] : []
    )
  );
  return indexablePages(project).filter(
    (page) =>
      !(
        latestVersions.has(page.version) &&
        !page.meta.seo.canonical &&
        currentKeys.has(`${page.versionKey}\u0000${page.locale}`)
      )
  );
};

/**
 * Each route's hreflang set, keyed by route: its indexable translations. The
 * page head links it, and so does the sitemap under `seo.sitemap.alternates`,
 * so the two never disagree, and neither points crawlers at a page they're
 * told not to index. A page that can't be indexed joins no set — except an
 * i18n fallback copy, which links the translations it stands in for.
 */
export const hreflangAlternates = (
  project: BlumeProject
): Map<string, RouteAlternate[]> => {
  const indexable = new Set(indexablePages(project).map((page) => page.route));
  return new Map(
    project.manifest.routes.map((route) => [
      route.path,
      route.fallback || indexable.has(route.path)
        ? route.alternates.filter((alternate) => indexable.has(alternate.path))
        : [],
    ])
  );
};

/**
 * Build the sitemap files from the route manifest plus the routes the manifest
 * can't see: custom `.astro` pages (most importantly a custom landing `/`) and
 * the generated `/changelog` index. Returns null when the sitemap is disabled
 * or no `site` is configured (absolute URLs are required for a valid sitemap).
 * Drafts, hidden, and `noindex` pages are excluded, and so is a page whose
 * `seo.canonical` points elsewhere.
 *
 * Sites within the per-file URL cap get the single classic `sitemap.xml`;
 * larger sites get `sitemap.xml` as a sitemap index over numbered
 * `sitemap-N.xml` chunks, all served from the same directory robots.txt
 * already points at.
 */
export const buildSitemapFiles = (
  project: BlumeProject
): SitemapFile[] | null => {
  const { site } = project.config.deployment.options;
  if (!(site && project.config.seo.sitemap)) {
    return null;
  }

  const base = siteRoot(site);
  // Routes carry `basePath`; a `deployment.base` subdirectory is mounted on
  // top of every one, even a route whose first segment matches it: under base
  // `/guides`, `guides/setup.md` is served at `/guides/guides/setup`.
  const deployBase = normalizeBasePath(project.config.deployment.options.base);
  const alternatesEnabled =
    project.config.seo.sitemap !== true &&
    project.config.seo.sitemap.alternates;
  const hreflang = alternatesEnabled ? hreflangAlternates(project) : null;
  // A page's translations as `xhtml:link`s, plus `x-default` at the default
  // locale's — the same set the page head links, for pages in 2+ locales.
  const alternateTags = (route: string): string => {
    const alternates = hreflang?.get(route) ?? [];
    if (alternates.length < 2) {
      return "";
    }
    const defaultPage = alternates.find(
      (entry) => entry.locale === project.config.i18n?.defaultLocale
    );
    const links = defaultPage
      ? [...alternates, { ...defaultPage, locale: "x-default" }]
      : alternates;
    return links
      .map(
        (entry) =>
          `<xhtml:link rel="alternate" hreflang="${escapeXml(entry.locale)}" href="${escapeXml(encodeURI(`${base}${mountBasePath(deployBase, entry.path)}`))}"/>`
      )
      .join("");
  };

  const seen = new Set<string>();
  const urls: string[] = [];
  const pushUrl = (
    route: string,
    lastModified?: string,
    alternates = ""
  ): void => {
    // `<loc>` must be a well-formed, XML-escaped URL: percent-encode the path,
    // then escape XML metacharacters (notably `&`) so a route like
    // `/Tips & Tricks` doesn't produce invalid XML that gets the whole sitemap
    // rejected.
    const loc = escapeXml(encodeURI(`${base}${route}`));
    if (seen.has(loc)) {
      return;
    }
    seen.add(loc);
    urls.push(
      `  <url><loc>${loc}</loc>${lastmodTag(lastModified)}${alternates}</url>`
    );
  };
  for (const page of listedPages(project)) {
    pushUrl(
      mountBasePath(deployBase, page.route),
      page.lastModified,
      alternateTags(page.route)
    );
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
    pushUrl(mountBasePath(deployBase, route));
  }
  urls.sort();

  if (urls.length <= URLS_PER_FILE) {
    return [
      { name: "sitemap.xml", xml: renderUrlset(urls, alternatesEnabled) },
    ];
  }

  const chunks: SitemapFile[] = [];
  const references: string[] = [];
  for (let start = 0; start < urls.length; start += URLS_PER_FILE) {
    const name = `sitemap-${chunks.length + 1}.xml`;
    chunks.push({
      name,
      xml: renderUrlset(
        urls.slice(start, start + URLS_PER_FILE),
        alternatesEnabled
      ),
    });
    // Chunks sit next to sitemap.xml, so their URLs layer the same deployment
    // base robots.txt uses for the index.
    const loc = escapeXml(
      encodeURI(`${base}${mountBasePath(deployBase, `/${name}`)}`)
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
