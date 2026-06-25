import type { BlumeProject } from "../core/project-graph.ts";

/**
 * Build a robots.txt that allows all crawlers and points to the sitemap when
 * one is available (a `site` is set and the sitemap is enabled). Returns null
 * when robots generation is disabled.
 */
export const buildRobots = (project: BlumeProject): string | null => {
  const { config } = project;
  if (!config.seo.robots) {
    return null;
  }

  const lines = ["User-agent: *", "Allow: /"];
  const { site } = config.deployment;
  if (site && config.seo.sitemap) {
    lines.push("", `Sitemap: ${site.replace(/\/$/u, "")}/sitemap.xml`);
  }
  return `${lines.join("\n")}\n`;
};
