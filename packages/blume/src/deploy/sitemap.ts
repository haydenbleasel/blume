import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { escapeXml } from "./xml.ts";

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
 * Build a sitemap.xml from the route manifest. Returns null when the sitemap is
 * disabled or no `site` is configured (absolute URLs are required for a valid
 * sitemap). Drafts, hidden, and `noindex` pages are excluded.
 */
export const buildSitemap = (project: BlumeProject): string | null => {
  const { site } = project.config.deployment;
  if (!(site && project.config.seo.sitemap)) {
    return null;
  }

  const base = site.replace(/\/$/u, "");
  // Routes carry `basePath`; a `deployment.base` subdirectory is layered on top.
  const deployBase = normalizeBasePath(project.config.deployment.base);
  const urls: string[] = [];
  for (const page of project.graph.pages) {
    if (page.meta.draft || page.meta.sidebar.hidden || page.meta.seo.noindex) {
      continue;
    }
    // `<loc>` must be a well-formed, XML-escaped URL: percent-encode the path,
    // then escape XML metacharacters (notably `&`) so a route like
    // `/Tips & Tricks` doesn't produce invalid XML that gets the whole sitemap
    // rejected.
    const loc = escapeXml(
      encodeURI(`${base}${withBasePath(deployBase, page.route)}`)
    );
    urls.push(`  <url><loc>${loc}</loc>${lastmodTag(page.lastModified)}</url>`);
  }
  urls.sort();

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
};
