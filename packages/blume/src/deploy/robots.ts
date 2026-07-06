import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ContentSignalPolicy, ContentSignals } from "../core/schema.ts";

/**
 * Ordered mapping from config field to its `Content-Signal` token. The order
 * fixes the emitted sequence (`search`, then `ai-input`, then `ai-train`).
 */
const SIGNAL_TOKENS: [keyof ContentSignalPolicy, string][] = [
  ["search", "search"],
  ["aiInput", "ai-input"],
  ["aiTrain", "ai-train"],
];

/**
 * The `Content-Signal:` line declaring how crawlers may reuse the site, or null
 * when the declaration is disabled (`contentSignals: false`). Otherwise every
 * signal is emitted with its resolved yes/no value.
 */
const contentSignalLine = (signals: ContentSignals): string | null => {
  if (!signals) {
    return null;
  }
  const tokens = SIGNAL_TOKENS.map(
    ([key, token]) => `${token}=${signals[key] ? "yes" : "no"}`
  );
  return `Content-Signal: ${tokens.join(", ")}`;
};

/**
 * Build a robots.txt that allows all crawlers, declares any configured
 * `Content-Signal` usage preferences, and points to the sitemap when one is
 * available (a `site` is set and the sitemap is enabled). Returns null when
 * robots generation is disabled.
 */
export const buildRobots = (project: BlumeProject): string | null => {
  const { config } = project;
  if (!config.seo.robots) {
    return null;
  }

  const lines = ["User-agent: *"];
  const signal = contentSignalLine(config.seo.contentSignals);
  if (signal) {
    lines.push(signal);
  }
  lines.push("Allow: /");

  const { site } = config.deployment;
  if (site && config.seo.sitemap) {
    const sitemapPath = withBasePath(
      normalizeBasePath(config.deployment.base),
      "/sitemap.xml"
    );
    lines.push("", `Sitemap: ${site.replace(/\/$/u, "")}${sitemapPath}`);
  }
  return `${lines.join("\n")}\n`;
};
