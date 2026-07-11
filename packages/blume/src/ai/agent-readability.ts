import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ContentSignalPolicy, ContentSignals } from "../core/schema.ts";
import { buildRssFeeds } from "../deploy/rss.ts";

/** Token map for the machine-readable content-usage echo. */
const USAGE_TOKENS: [keyof ContentSignalPolicy, string][] = [
  ["search", "search"],
  ["aiInput", "ai-input"],
  ["aiTrain", "ai-train"],
];

/**
 * The configured usage preferences as a `{ token: allowed }` object, or null
 * when the declaration is disabled (`contentSignals: false`). Mirrors the
 * robots.txt `Content-Signal` line so an agent that reads the manifest instead
 * of robots.txt sees the same policy.
 */
const usagePolicy = (
  signals: ContentSignals
): Record<string, boolean> | null => {
  if (!signals) {
    return null;
  }
  return Object.fromEntries(
    USAGE_TOKENS.map(([key, token]) => [token, signals[key]] as const)
  );
};

/**
 * Build `agent-readability.json`: a root manifest that indexes the project's
 * agent-facing surface — llms.txt, the raw-Markdown mirrors, the MCP server,
 * Ask AI, sitemap, and feeds — so agents can discover and cite the docs without
 * scraping HTML. URLs are absolute when a `site` is configured and root-relative
 * (still under `deployment.base`) otherwise. Returns null when the manifest is
 * disabled.
 */
export const buildAgentReadability = (
  project: BlumeProject
): Record<string, unknown> | null => {
  const { config } = project;
  if (!config.seo.agentReadability) {
    return null;
  }

  const site = config.deployment.site ?? null;
  // Every artifact is served under `deployment.base` — with or without a
  // `site`; concatenate rather than `new URL()` so the subpath is preserved.
  const deployBase = normalizeBasePath(config.deployment.base);
  const abs = (path: string): string => {
    const based = withBasePath(deployBase, path);
    return site ? `${site.replace(/\/+$/u, "")}${based}` : based;
  };

  const artifacts: Record<string, unknown> = {
    markdown: {
      contentNegotiation: "text/markdown",
      pattern: abs("/{route}.md"),
    },
  };
  if (config.ai.llmsTxt.enabled) {
    artifacts.llmsFullTxt = abs("/llms-full.txt");
    artifacts.llmsTxt = abs("/llms.txt");
  }
  if (config.mcp.enabled) {
    artifacts.mcp = {
      discovery: abs("/.well-known/mcp.json"),
      url: abs(config.mcp.route),
    };
  }
  if (config.ai.ask?.enabled) {
    artifacts.askApi = abs("/api/ask");
  }
  if (site && config.seo.sitemap) {
    artifacts.sitemap = abs("/sitemap.xml");
  }
  const feeds =
    site && config.seo.rss.enabled
      ? buildRssFeeds(project).map((feed) => abs(feed.path))
      : [];
  if (feeds.length > 0) {
    artifacts.feeds = feeds;
  }

  const version = project.manifest?.blumeVersion;
  const manifest: Record<string, unknown> = {
    artifacts,
    description: config.description,
    generator: version ? `blume@${version}` : undefined,
    name: config.mcp.name ?? config.title,
    site,
  };

  const usage = usagePolicy(config.seo.contentSignals);
  if (usage) {
    manifest.contentUsage = usage;
  }
  if (config.github) {
    manifest.repository = `https://github.com/${config.github.owner}/${config.github.repo}`;
  }

  return manifest;
};
