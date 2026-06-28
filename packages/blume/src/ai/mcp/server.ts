import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { buildOramaIndex, queryOramaIndex } from "../../search/orama-index.ts";
import type { OramaDoc } from "../../search/orama-index.ts";
import type { McpData } from "./data.ts";
import { MCP_TOOLS } from "./tools.ts";

/**
 * The low-level SDK `Server` is used (rather than the high-level `McpServer`)
 * because the latter's `registerTool` is generic over the caller's Zod version;
 * Blume pins Zod 3 while the SDK resolves Zod 4, so their types don't unify.
 * Hand-written JSON Schema and the SDK's own request schemas avoid that entirely.
 */

/** Default and maximum number of hits returned by `search_docs`. */
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
/** Excerpt length when a page has no description. */
const EXCERPT_LENGTH = 200;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Headers":
    "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

/** JSON Schema for each tool's input, keyed by tool name. */
const INPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  get_navigation: { properties: {}, type: "object" },
  get_page: {
    properties: {
      route: {
        description: "The page route, e.g. `/guides/install`.",
        type: "string",
      },
    },
    required: ["route"],
    type: "object",
  },
  list_pages: { properties: {}, type: "object" },
  search_docs: {
    properties: {
      limit: {
        description: `Maximum hits to return (default ${DEFAULT_SEARCH_LIMIT}).`,
        maximum: MAX_SEARCH_LIMIT,
        minimum: 1,
        type: "integer",
      },
      query: { description: "The search query.", type: "string" },
    },
    required: ["query"],
    type: "object",
  },
};

/** The `tools/list` payload, derived from shared metadata + input schemas. */
const TOOL_DEFINITIONS = MCP_TOOLS.map((tool) => ({
  annotations: tool.annotations,
  description: tool.description,
  inputSchema: INPUT_SCHEMAS[tool.name],
  name: tool.name,
  title: tool.title,
}));

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asLimit = (value: unknown): number => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(num), 1), MAX_SEARCH_LIMIT);
};

/** Normalize a user-supplied route to a `pages` key (`/`, `/a/b`, no suffix). */
const normalizeRoute = (input: string): string => {
  const noTrailing = input.trim().replace(/\/+$/u, "");
  const noSuffix = noTrailing.replace(/\.mdx?$/u, "");
  const withSlash = noSuffix.startsWith("/") ? noSuffix : `/${noSuffix}`;
  return withSlash === "" ? "/" : withSlash;
};

/** Build the absolute (or root-relative) URL for a route. */
const urlFor = (route: string, site: string | null): string =>
  site ? new URL(route, site).href : route;

const text = (value: string, isError = false) => ({
  content: [{ text: value, type: "text" as const }],
  ...(isError ? { isError: true } : {}),
});

/** Construct a fresh MCP server with Blume's read-only docs tools registered. */
const buildServer = (
  data: McpData,
  index: () => Promise<Awaited<ReturnType<typeof buildOramaIndex>>>
): Server => {
  const server = new Server(
    { name: data.name, version: data.version },
    {
      capabilities: { tools: {} },
      ...(data.instructions ? { instructions: data.instructions } : {}),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { arguments: args = {}, name } = request.params;

    if (name === "search_docs") {
      const db = await index();
      const hits = await queryOramaIndex(
        db,
        asString(args.query),
        asLimit(args.limit)
      );
      const results = hits.map((doc: OramaDoc) => ({
        excerpt:
          doc.description || `${doc.content.slice(0, EXCERPT_LENGTH)}…`.trim(),
        title: doc.title,
        url: urlFor(doc.route, data.site),
      }));
      return text(JSON.stringify(results, null, 2));
    }

    if (name === "get_page") {
      const key = normalizeRoute(asString(args.route));
      const markdown = data.pages[key];
      if (markdown === undefined) {
        return text(
          `No page found at "${key}". Use list_pages or search_docs to find valid routes.`,
          true
        );
      }
      return text(markdown);
    }

    if (name === "list_pages") {
      return text(
        JSON.stringify(
          data.routes.map((route) => ({
            contentType: route.contentType,
            description: route.description,
            lastModified: route.lastModified,
            route: route.route,
            title: route.title,
            url: urlFor(route.route, data.site),
          })),
          null,
          2
        )
      );
    }

    if (name === "get_navigation") {
      return text(JSON.stringify(data.navigation, null, 2));
    }

    return text(`Unknown tool: ${name}`, true);
  });

  return server;
};

/**
 * Build a stateless Streamable-HTTP MCP request handler from a data snapshot.
 *
 * The Orama index is built once and reused; a fresh `Server` and transport are
 * created per request (required by the SDK's stateless mode, which skips session
 * tracking). `enableJsonResponse` makes each call a plain request/response — no
 * SSE — which suits read-only docs tools and runs on any adapter (Node, Vercel,
 * Netlify, Cloudflare). CORS is added so browser-based connectors (e.g.
 * claude.ai) can reach the endpoint.
 */
export const createMcpFetchHandler = (
  data: McpData
): ((request: Request) => Promise<Response>) => {
  let dbPromise: Promise<Awaited<ReturnType<typeof buildOramaIndex>>> | null =
    null;
  const index = () => {
    dbPromise ??= buildOramaIndex(data.documents);
    return dbPromise;
  };

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS, status: 204 });
    }
    if (request.method === "GET") {
      // No server-initiated streams are needed for read-only tools.
      return new Response("Method Not Allowed", {
        headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" },
        status: 405,
      });
    }

    const server = buildServer(data, index);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
};
