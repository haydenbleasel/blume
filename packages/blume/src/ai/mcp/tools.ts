/**
 * Static metadata for the MCP tools Blume exposes. Shared by the server (which
 * pairs each entry with a Zod input schema and handler) and the `.well-known`
 * discovery documents, so tool names and descriptions never drift between the
 * live server and its advertised capabilities.
 */

/** A read-only, non-mutating tool hint set (every Blume tool is read-only). */
const READ_ONLY = { openWorldHint: false, readOnlyHint: true } as const;

export interface McpToolMeta {
  annotations: { openWorldHint: boolean; readOnlyHint: boolean };
  description: string;
  name: string;
  title: string;
}

export const MCP_TOOLS: McpToolMeta[] = [
  {
    annotations: READ_ONLY,
    description:
      "Full-text search across the documentation. Returns matching pages with their title, route, and a short excerpt. Use this first to discover relevant pages, then `get_page` to read one in full.",
    name: "search_docs",
    title: "Search documentation",
  },
  {
    annotations: READ_ONLY,
    description:
      "Fetch a single documentation page as agent-optimized Markdown (frontmatter included, components downleveled to plain Markdown). Pass a route from `search_docs` or `list_pages`, e.g. `/guides/install`.",
    name: "get_page",
    title: "Get page Markdown",
  },
  {
    annotations: READ_ONLY,
    description:
      "List every documentation page with its route, title, description, and content type. Useful for enumerating the docs or finding a page when search is too narrow.",
    name: "list_pages",
    title: "List pages",
  },
  {
    annotations: READ_ONLY,
    description:
      "Return the documentation navigation tree (header tabs and the sidebar hierarchy), reflecting how the docs are organized for readers.",
    name: "get_navigation",
    title: "Get navigation",
  },
];
