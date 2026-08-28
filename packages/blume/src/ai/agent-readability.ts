import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import { repoUrl } from "../core/github.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ContentSignalPolicy, ContentSignals } from "../core/schema.ts";
import { absoluteUrl } from "../core/site-url.ts";
import { buildRssFeeds } from "../deploy/rss.ts";
import { hasApiCatalog } from "./api-catalog.ts";

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
 * The advertised Ask AI URL. An external endpoint is not served under
 * `deployment.base`, so a root-relative one absolutizes against the site
 * origin alone; the built-in route gets site and base via `abs`.
 */
const askApiUrl = (
  endpoint: string | undefined,
  site: string | null,
  abs: (path: string) => string
): string => {
  if (!endpoint) {
    return abs("/api/ask");
  }
  return site && endpoint.startsWith("/")
    ? absoluteUrl(site, endpoint)
    : endpoint;
};

/** The `.well-known` discovery URLs a site can publish. */
interface WellKnownArtifacts {
  httpMessageSignaturesDirectory?: string;
  apiCatalog?: string;
  agentSkills?: string;
}

/** The agent-facing artifact index the manifest publishes. */
interface AgentArtifacts extends WellKnownArtifacts {
  markdown: { contentNegotiation?: string; pattern: string };
  llmsFullTxt?: string;
  llmsTxt?: string;
  mcp?: { discovery: string; url: string };
  askApi?: string;
  sitemap?: string;
  feeds?: string[];
}

/** The published `agent-readability.json` document. */
export interface AgentReadabilityManifest {
  artifacts: AgentArtifacts;
  description?: string;
  generator?: string;
  name: string;
  site: string | null;
  contentUsage?: Record<string, boolean>;
  repository?: string;
}

/** The `.well-known` discovery artifacts the site publishes, if any. */
const wellKnownArtifacts = (
  config: BlumeProject["config"],
  abs: (path: string) => string
): WellKnownArtifacts => {
  const artifacts: WellKnownArtifacts = {};
  if (config.ai.webBotAuth.keys.length > 0) {
    artifacts.httpMessageSignaturesDirectory = abs(
      "/.well-known/http-message-signatures-directory"
    );
  }
  if (hasApiCatalog(config)) {
    artifacts.apiCatalog = abs("/.well-known/api-catalog");
  }
  if (config.ai.skills) {
    artifacts.agentSkills = abs("/.well-known/agent-skills/index.json");
  }
  return artifacts;
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
): AgentReadabilityManifest | null => {
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
    return site ? absoluteUrl(site, based) : based;
  };

  // Advertise `Accept: text/markdown` negotiation only where the deployed site
  // actually honors it — a Vercel server build, whose routing config gets the
  // rewrite rules (see `deploy/vercel-negotiation.ts`), and a Cloudflare server
  // build, whose deploy bundle gets a wrapper Worker (see
  // `deploy/cloudflare-negotiation.ts`). Static builds and other adapters serve
  // prerendered pages from a static layer with no request-time hook, so agents
  // there should fetch the `.md` pattern directly.
  const negotiates =
    config.deployment.output === "server" &&
    (config.deployment.adapter === "vercel" ||
      config.deployment.adapter === "cloudflare");
  const markdown: AgentArtifacts["markdown"] = negotiates
    ? { contentNegotiation: "text/markdown", pattern: abs("/{route}.md") }
    : { pattern: abs("/{route}.md") };
  const artifacts: AgentArtifacts = { markdown };
  if (config.ai.llmsTxt.enabled) {
    artifacts.llmsFullTxt = abs("/llms-full.txt");
    artifacts.llmsTxt = abs("/llms.txt");
  }
  if (config.ai.mcp.enabled) {
    artifacts.mcp = {
      discovery: abs("/.well-known/mcp.json"),
      url: abs(config.ai.mcp.route),
    };
  }
  if (config.ai.ask?.enabled) {
    artifacts.askApi = askApiUrl(config.ai.ask.endpoint, site, abs);
  }
  Object.assign(artifacts, wellKnownArtifacts(config, abs));
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
  const manifest: AgentReadabilityManifest = {
    artifacts,
    description: config.description,
    generator: version ? `blume@${version}` : undefined,
    name: config.ai.mcp.name ?? config.title,
    site,
  };

  const usage = usagePolicy(config.seo.contentSignals);
  if (usage) {
    manifest.contentUsage = usage;
  }
  if (config.github) {
    manifest.repository = repoUrl(config.github);
  }

  return manifest;
};
