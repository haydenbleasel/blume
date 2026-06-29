import type { BlumeProject } from "../../core/project-graph.ts";
import type { Navigation } from "../../core/types.ts";
import { buildSearchDocuments } from "../../search/documents.ts";
import type { OramaDoc } from "../../search/orama-index.ts";
import { buildRawMarkdown } from "../markdown.ts";

/** A page entry surfaced by the `list_pages` MCP tool. */
export interface McpRoute {
  contentType: string;
  description?: string;
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
  const [documents, pages] = await Promise.all([
    // The MCP server is independent of on-page search, so index docs even when
    // the search provider is `none`.
    buildSearchDocuments(project, { includeWhenDisabled: true }),
    buildRawMarkdown(project),
  ]);

  const descriptionById = new Map(
    graph.pages.map((page) => [page.id, page.description])
  );

  const routes: McpRoute[] = manifest.routes
    .filter((route) => !route.hidden)
    .map((route) => ({
      contentType: route.contentType,
      description: descriptionById.get(route.id),
      indexable: route.indexable,
      lastModified: route.lastModified ?? null,
      route: route.path,
      title: route.title,
    }));

  return {
    documents: documents.map((doc) => ({
      content: doc.content,
      description: doc.description,
      route: doc.route,
      title: doc.title,
    })),
    instructions: config.mcp.instructions,
    name: config.mcp.name ?? config.title,
    navigation: graph.navigation,
    pages,
    routes,
    site: config.deployment.site ?? null,
    version: manifest.blumeVersion,
  };
};
