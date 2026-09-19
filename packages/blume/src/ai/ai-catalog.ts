import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { absoluteUrl } from "../core/site-url.ts";
import { resolveReferences } from "../openapi/references.ts";
import { API_CATALOG_PATH, hasApiCatalog } from "./api-catalog.ts";
import { OPENAPI_PATH } from "./api/paths.ts";
import { asciiSlugify } from "./mcp/discovery.ts";
import { AGENT_SKILLS_DIR } from "./skills.ts";
import type { SkillArtifact } from "./skills.ts";

/**
 * The AI Catalog (Agent-Card/ai-catalog data model, `specVersion` 1.0) at
 * `/.well-known/ai-catalog.json`, which is also the Agentic Resource
 * Discovery (ARD) manifest: one entry per agent-facing resource the site
 * publishes, each an `urn:air:<host>:<namespace>:<name>` identifier, a
 * display name, the artifact's media type, a URL, and the
 * `representativeQueries` registries embed for semantic search. Like the
 * RFC 9727 catalog next to it, everything is derived from `blume.config.ts`
 * and the build's published skills — nothing is hand-written.
 *
 * ARD v0.91 moved its manifest to `/.well-known/ard.json` and calls
 * `ai-catalog.json` the predecessor path that consumers only *may* consult,
 * while the ai-catalog spec and today's agent-readiness scanners key on
 * `ai-catalog.json`. The ARD manifest is just an `entries` array (other
 * members are ignored), so the one document is written to both paths.
 *
 * Served as plain `application/json`: the `.json` extension gets it from
 * every static host with no header rule, and the scanners that gate on the
 * file ask for exactly that type. The registered `application/ai-catalog+json`
 * is what the `Link`/`<link>` advertisements declare the document to be.
 */

export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
export const ARD_MANIFEST_PATH = "/.well-known/ard.json";
export const AI_CATALOG_TYPE = "application/ai-catalog+json";
const SPEC_VERSION = "1.0";

/** One catalog entry, restricted to the terms Blume emits. */
interface CatalogEntry {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  description?: string;
  capabilities?: string[];
  representativeQueries: string[];
}

/** An entry before its identifier and queries are resolved against the host. */
interface EntrySeed {
  /** `<namespace>:<name>` — the identifier's tail and the `queries` key. */
  key: string;
  displayName: string;
  type: string;
  url: string;
  description?: string;
  capabilities?: string[];
  /** Generated queries, replaced wholesale by a configured `queries[key]`. */
  queries: string[];
}

const REFERENCE_KIND_LABEL = {
  asyncapi: "AsyncAPI",
  graphql: "GraphQL",
  openapi: "OpenAPI",
} as const;

/** The `urn:air` publisher: the configured site's hostname. */
const publisherHost = (site: string): string => new URL(site).hostname;

/**
 * Whether the site publishes a catalog: the feature is on, a `deployment.site`
 * anchors the identifiers, and at least one entry exists. Every entry source
 * is a config flag, so the answer needs no build output — the same gate the
 * header rules, the `Link` header, and the head links read.
 */
export const hasAiCatalog = (config: ResolvedConfig): boolean =>
  config.ai.catalog.enabled &&
  Boolean(config.deployment.options.site) &&
  (config.ai.mcp.enabled ||
    config.ai.api ||
    config.ai.llmsTxt.enabled ||
    Boolean(config.ai.skills) ||
    resolveReferences(config).length > 0);

/**
 * The `.well-known` documents agent registries fetch cross-origin (browser
 * agents, hosted registries reading through a page). Each needs
 * `Access-Control-Allow-Origin: *` on the static surface; the MCP endpoint
 * itself already sets it at runtime.
 */
export const crossOriginDiscoveryPaths = (config: ResolvedConfig): string[] => {
  const paths: string[] = [];
  if (hasAiCatalog(config)) {
    paths.push(AI_CATALOG_PATH, ARD_MANIFEST_PATH);
  }
  if (hasApiCatalog(config)) {
    paths.push(API_CATALOG_PATH);
  }
  if (config.ai.mcp.enabled) {
    paths.push("/.well-known/mcp.json", "/.well-known/mcp/server-card.json");
  }
  return paths;
};

const entrySeeds = (
  config: ResolvedConfig,
  skills: readonly SkillArtifact[],
  abs: (path: string) => string
): EntrySeed[] => {
  const { title } = config;
  const seeds: EntrySeed[] = [];

  if (config.ai.mcp.enabled) {
    const name = config.ai.mcp.name ?? title;
    seeds.push({
      capabilities: ["search_docs", "get_page", "list_pages", "get_navigation"],
      description:
        config.ai.mcp.instructions ??
        `Model Context Protocol server over the ${title} documentation: full-text search, page Markdown, the page index, and the navigation tree.`,
      displayName: name,
      key: `mcp:${asciiSlugify(name) || "docs"}`,
      queries: [
        `search the ${title} documentation`,
        `get a ${title} docs page as Markdown`,
        `list every page in the ${title} docs`,
      ],
      type: "application/mcp-server-card+json",
      url: abs("/.well-known/mcp/server-card.json"),
    });
  }

  for (const skill of skills) {
    seeds.push({
      description: skill.description,
      displayName: skill.name,
      key: `skill:${skill.name}`,
      queries: [
        `load the ${skill.name} agent skill`,
        `how do I use ${skill.name}`,
      ],
      type:
        skill.type === "archive"
          ? "application/agent-skills+gzip"
          : "application/agent-skills+md",
      url: abs(`${AGENT_SKILLS_DIR}/${skill.path}`),
    });
  }

  if (config.ai.api) {
    seeds.push({
      description: `REST API over the ${title} documentation: the page index, each page as JSON or Markdown, and the navigation tree, described by this OpenAPI document.`,
      displayName: `${title} docs API`,
      key: "api:docs",
      queries: [
        `fetch a ${title} docs page as JSON`,
        `list the pages in the ${title} docs`,
        `get the ${title} docs navigation tree`,
      ],
      type: "application/vnd.oai.openapi+json",
      url: abs(OPENAPI_PATH),
    });
  }

  for (const reference of resolveReferences(config)) {
    // Blume-rendered pages mount under `basePath`; Scalar pages stay at the
    // raw route (see `referenceRoutes`). The rendered reference is the
    // resource this publisher owns — the spec itself is catalogued by URL in
    // the RFC 9727 linkset.
    const docRoute =
      reference.renderer === "blume"
        ? withBasePath(reference.basePath, reference.route)
        : reference.route;
    seeds.push({
      description: `${reference.label}: rendered ${REFERENCE_KIND_LABEL[reference.kind]} reference in the ${title} documentation.`,
      displayName: reference.label,
      key: `reference:${reference.slug}`,
      queries: [
        `what operations does the ${reference.label} API expose`,
        `how do I call the ${reference.label} API`,
      ],
      type: "text/html",
      url: abs(docRoute),
    });
  }

  if (config.ai.llmsTxt.enabled) {
    seeds.push({
      description: `llms.txt index of the ${title} documentation: every page with a one-line summary, plus the agent-facing resources on this site.`,
      displayName: `${title} llms.txt`,
      key: "docs:llms-txt",
      queries: [`what is ${title}`, `overview of the ${title} documentation`],
      type: "text/plain",
      url: abs("/llms.txt"),
    });
  }

  return seeds;
};

/** The catalog document, or null when the site publishes none. */
export const buildAiCatalog = (
  config: ResolvedConfig,
  skills: readonly SkillArtifact[]
): string | null => {
  const site = config.deployment.options.site ?? null;
  if (!(site && hasAiCatalog(config))) {
    return null;
  }
  const deployBase = normalizeBasePath(config.deployment.options.base);
  const abs = (path: string): string =>
    absoluteUrl(site, withBasePath(deployBase, path));
  const host = publisherHost(site);
  const entries = entrySeeds(config, skills, abs).map((seed): CatalogEntry => {
    const entry: CatalogEntry = {
      displayName: seed.displayName,
      identifier: `urn:air:${host}:${seed.key}`,
      representativeQueries:
        config.ai.catalog.queries[seed.key] ?? seed.queries,
      type: seed.type,
      url: seed.url,
    };
    if (seed.description) {
      entry.description = seed.description;
    }
    if (seed.capabilities) {
      entry.capabilities = seed.capabilities;
    }
    return entry;
  });
  const catalog = {
    entries,
    host: {
      displayName: config.title,
      documentationUrl: abs("/"),
      identifier: `did:web:${host}`,
    },
    specVersion: SPEC_VERSION,
  };
  return `${JSON.stringify(catalog, null, 2)}\n`;
};
