import { MCP_TOOLS } from "./tools.ts";

/** Inputs needed to describe the MCP server in discovery documents. */
export interface McpDiscoveryInput {
  name: string;
  route: string;
  site: string | null;
  version: string;
}

/** The MCP server's address — absolute when a site is configured. */
const serverUrl = (input: McpDiscoveryInput): string =>
  input.site ? new URL(input.route, input.site).href : input.route;

/**
 * The `/.well-known/mcp.json` discovery document: the minimal pointer agents use
 * to find the server and its transport.
 */
export const buildMcpDiscovery = (
  input: McpDiscoveryInput
): Record<string, unknown> => ({
  servers: [
    {
      name: input.name,
      transport: "streamable-http",
      url: serverUrl(input),
    },
  ],
});

/**
 * The `/.well-known/mcp/server-card.json` document: richer metadata including
 * the advertised tool set (full input schemas are served live via `tools/list`).
 */
export const buildMcpServerCard = (
  input: McpDiscoveryInput
): Record<string, unknown> => ({
  description: `Model Context Protocol server for the ${input.name} documentation.`,
  name: input.name,
  tools: MCP_TOOLS.map((tool) => ({
    annotations: tool.annotations,
    description: tool.description,
    name: tool.name,
    title: tool.title,
  })),
  transport: "streamable-http",
  url: serverUrl(input),
  version: input.version,
});
