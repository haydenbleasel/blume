import type { BlumeProject } from "../core/project-graph.ts";

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
  const urls = project.graph.pages
    .filter(
      (page) =>
        !(page.meta.draft || page.meta.sidebar.hidden || page.meta.seo.noindex)
    )
    .map((page) => `  <url><loc>${base}${page.route}</loc></url>`)
    .toSorted();

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
};
