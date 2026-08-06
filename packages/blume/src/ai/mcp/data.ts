import { normalizeBasePath } from "../../core/base-path.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import type { Navigation } from "../../core/types.ts";
import { buildSearchDocuments } from "../../search/documents.ts";
import { pageFacets } from "../../search/facets.ts";
import type { OramaDoc } from "../../search/orama-index.ts";
import { agentMarkdown, buildRawMarkdown } from "../markdown.ts";

/** A page entry surfaced by the `list_pages` MCP tool. */
export interface McpRoute {
  contentType: string;
  description?: string;
  /** Declared facet values (`content.types.<type>.facets`), key → value. */
  facets?: Record<string, string>;
  indexable: boolean;
  lastModified: string | null;
  route: string;
  title: string;
}

/**
 * The self-contained snapshot the generated MCP endpoint serves. Bundles the
 * search documents, raw page Markdown, route list, and navigation so the server
 * works regardless of the configured search provider and needs no filesystem
 * access at request time. Serialized to `generated/mcp-data.json`.
 */
export interface McpData {
  /**
   * Normalized `deployment.base` (`""` or `/seg`), layered onto routes when
   * emitting URLs — the site is base-less and routes are base-less manifest
   * paths, matching the sitemap/llms.txt convention.
   */
  base: string;
  /**
   * The site's `i18n.defaultLocale`, when i18n is configured. Selects a
   * word-segmenting Orama tokenizer for languages written without spaces, so
   * `search_docs` can match CJK/Thai content.
   */
  defaultLocale?: string;
  documents: OramaDoc[];
  instructions?: string;
  name: string;
  navigation: Navigation;
  pages: Record<string, string>;
  routes: McpRoute[];
  site: string | null;
  version: string;
}

/** Build the MCP data snapshot from a resolved project. */
export const buildMcpData = async (project: BlumeProject): Promise<McpData> => {
  const { config, graph, manifest } = project;
  const [documents, rawMarkdown] = await Promise.all([
    // The MCP server is independent of on-page search, so index docs even when
    // the search provider is `none`. Documents are agent-facing, so
    // `<Visibility>` resolves like `get_page`/llms-full.txt (web-only content
    // removed, agents-only kept).
    buildSearchDocuments(project, {
      audience: "agents",
      includeWhenDisabled: true,
    }),
    buildRawMarkdown(project),
  ]);

  // `get_page` serves the agent variant: components downleveled to Markdown.
  const pages = Object.fromEntries(
    Object.entries(rawMarkdown).map(([route, entry]) => [
      route,
      agentMarkdown(entry),
    ])
  );

  const pageById = new Map(graph.pages.map((page) => [page.id, page]));

  const routes: McpRoute[] = [];
  for (const route of manifest.routes) {
    if (route.hidden) {
      continue;
    }
    const page = pageById.get(route.id);
    const facets = page ? pageFacets(page, config) : undefined;
    routes.push({
      contentType: route.contentType,
      description: page?.description,
      ...(facets ? { facets } : {}),
      indexable: route.indexable,
      lastModified: route.lastModified ?? null,
      route: route.path,
      title: route.title,
    });
  }

  return {
    base: normalizeBasePath(config.deployment.base),
    defaultLocale: config.i18n?.defaultLocale,
    documents: documents.map((doc) => ({
      content: doc.content,
      contentType: doc.contentType,
      description: doc.description,
      ...(doc.facets ? { facets: doc.facets } : {}),
      route: doc.route,
      title: doc.title,
    })),
    instructions: config.ai.mcp.instructions,
    name: config.ai.mcp.name ?? config.title,
    navigation: graph.navigation,
    pages,
    routes,
    site: config.deployment.site ?? null,
    version: manifest.blumeVersion,
  };
};
