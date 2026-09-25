import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { mountBasePath } from "../../core/base-path.ts";
import { readCappedText } from "../../core/request-body.ts";
import type { McpData } from "./data.ts";
import {
  createIndexProvider,
  getNavigation,
  getPageMarkdown,
  listPages,
  normalizeRoute,
  searchDocs,
  TOOL_INPUTS,
  urlFor,
} from "./query.ts";
import type { OramaIndexProvider } from "./query.ts";
import { MCP_TOOLS } from "./tools.ts";

export { createIndexProvider } from "./query.ts";
export type { OramaIndexProvider } from "./query.ts";

/**
 * The low-level SDK `Server` is used (rather than the high-level `McpServer`)
 * because the latter's `registerTool` is generic over the caller's Zod instance;
 * Blume's zod and the SDK's may resolve to different copies, whose types don't
 * unify. The operations themselves live in `query.ts`, shared with the JSON
 * docs API; this module is the MCP transport over them.
 */

/** Every page resource is the page's agent Markdown. */
const RESOURCE_MIME_TYPE = "text/markdown";
/** The MCP spec's JSON-RPC code for an unknown resource URI. */
const RESOURCE_NOT_FOUND = -32_002;
/** URI scheme for page resources when no `deployment.site` is configured. */
const LOCAL_RESOURCE_SCHEME = "blume:";
/**
 * The largest request body the HTTP endpoint reads. A JSON-RPC call to these
 * tools is a few hundred bytes; the cap keeps one oversized POST from being
 * buffered whole, as the assistant route's does.
 */
const MCP_BODY_LIMIT_BYTES = 65_536;

const CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

/**
 * A tool's advertised JSON Schema. The dialect key is dropped (noise in a
 * tools/list payload), as is the root `additionalProperties: false` — the
 * runtime strips unknown keys rather than rejecting them, and the advertised
 * schema shouldn't promise stricter validation than the server performs.
 */
const inputSchemaFor = (schema: z.ZodType) => {
  const {
    $schema: _dialect,
    additionalProperties: _closed,
    ...rest
  } = z.toJSONSchema(schema);
  return rest;
};

/** The `tools/list` payload, derived from shared metadata + input schemas. */
const TOOL_DEFINITIONS = MCP_TOOLS.map((tool) => ({
  annotations: tool.annotations,
  description: tool.description,
  inputSchema: inputSchemaFor(
    // SAFETY: TOOL_INPUTS declares a schema for every MCP_TOOLS name; the two
    // lists are maintained together so names and descriptions never drift.
    TOOL_INPUTS[tool.name as keyof typeof TOOL_INPUTS]
  ),
  name: tool.name,
  title: tool.title,
}));

/** One `resources/list` entry: a page served as `text/markdown`. */
interface PageResource {
  description?: string;
  mimeType: string;
  name: string;
  title: string;
  uri: string;
}

/**
 * A page's resource URI. Resource URIs must be absolute, so this is the page's
 * served URL when a site is configured (the same URL `search_docs` and
 * `list_pages` emit, so an agent can hand either back to `resources/read`),
 * and a `blume:` URI carrying the based route otherwise.
 */
const resourceUri = (route: string, data: McpData): string =>
  data.site
    ? urlFor(route, data)
    : `${LOCAL_RESOURCE_SCHEME}${mountBasePath(data.base, route)}`;

/** The `pages` key a resource URI (either form, or a bare route) names. */
const resourceRoute = (uri: string, data: McpData): string =>
  normalizeRoute(
    uri.startsWith(LOCAL_RESOURCE_SCHEME)
      ? uri.slice(LOCAL_RESOURCE_SCHEME.length)
      : uri,
    data
  );

/**
 * The `tools/call` params, as far as the server reads them before dispatch:
 * each tool validates its own `arguments` against `TOOL_INPUTS`.
 */
const TOOL_CALL_PARAMS = z.object({
  arguments: z.record(z.string(), z.unknown()).optional(),
  name: z.string(),
});

/** A tool call's `arguments` object, before the tool's own validation. */
type ToolArguments = NonNullable<
  z.output<typeof TOOL_CALL_PARAMS>["arguments"]
>;

/** A tool call's text result, marked as an error when `isError` is set. */
const text = (value: string, isError = false) => {
  const content = [{ text: value, type: "text" as const }];
  return isError ? { content, isError: true } : { content };
};

/** Construct a fresh MCP server with Blume's read-only docs tools registered. */
export const buildServer = (
  data: McpData,
  index: OramaIndexProvider
): Server => {
  const capabilities = { resources: {}, tools: {} };
  const serverOptions: ServerOptions = data.instructions
    ? { capabilities, instructions: data.instructions }
    : { capabilities };
  const server = new Server(
    { name: data.name, version: data.version },
    serverOptions
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Every page doubles as a resource, so a client that attaches context by
  // URI (rather than calling tools) can browse and read the docs too. The
  // list is the same route set `list_pages` returns; reading one serves the
  // same agent Markdown `get_page` does.
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: data.routes.map((route) => {
      const resource: PageResource = {
        mimeType: RESOURCE_MIME_TYPE,
        name: route.title,
        title: route.title,
        uri: resourceUri(route.route, data),
      };
      if (route.description) {
        resource.description = route.description;
      }
      return resource;
    }),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params;
    const markdown = getPageMarkdown(data, resourceRoute(uri, data));
    if (markdown === undefined) {
      throw new McpError(
        RESOURCE_NOT_FOUND,
        `No page found at "${uri}". Use resources/list or list_pages to find valid URIs.`
      );
    }
    return {
      contents: [{ mimeType: RESOURCE_MIME_TYPE, text: markdown, uri }],
    };
  });

  const callTool = async (name: string, args: ToolArguments) => {
    if (name === "search_docs") {
      const results = await searchDocs(
        data,
        index,
        TOOL_INPUTS.search_docs.parse(args)
      );
      return text(JSON.stringify(results, null, 2));
    }

    if (name === "get_page") {
      const input = TOOL_INPUTS.get_page.parse(args);
      const key = normalizeRoute(input.route, data);
      const markdown = getPageMarkdown(data, key);
      if (markdown === undefined) {
        return text(
          `No page found at "${key}". Use list_pages or search_docs to find valid routes.`,
          true
        );
      }
      return text(markdown);
    }

    if (name === "list_pages") {
      const listing = listPages(data, TOOL_INPUTS.list_pages.parse(args));
      return text(JSON.stringify(listing, null, 2));
    }

    if (name === "get_navigation") {
      const result = getNavigation(
        data,
        TOOL_INPUTS.get_navigation.parse(args)
      );
      if ("error" in result) {
        return text(result.error, true);
      }
      return text(JSON.stringify(result.navigation, null, 2));
    }

    // The MCP spec answers an unknown tool with a protocol error, not a
    // failed tool result.
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  };

  // `tools/call` goes through the fallback handler rather than a registered
  // one: the SDK parses a registered handler's request against its own
  // schema first and reports a malformed call (`arguments` that aren't an
  // object) as -32603 Internal error carrying a raw Zod dump. Reading the
  // params here answers it as -32602 Invalid params with a short message.
  server.fallbackRequestHandler = async (request) => {
    if (request.method !== "tools/call") {
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    }
    const params = TOOL_CALL_PARAMS.safeParse(request.params);
    if (!params.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid tools/call params: `name` must be a string and `arguments`, when given, an object."
      );
    }
    return await callTool(params.data.name, params.data.arguments ?? {});
  };

  return server;
};

/** A JSON-RPC error response the transport would send, for errors raised before it runs. */
const jsonRpcError = (
  status: number,
  code: number,
  message: string
): Response =>
  Response.json(
    { error: { code, message }, id: null, jsonrpc: "2.0" },
    { headers: CORS_HEADERS, status }
  );

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
  const index = createIndexProvider(data.documents, data.defaultLocale);

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

    // The transport would read the body with `request.json()`, buffering
    // whatever a client sends; read it under the cap first and hand the
    // transport a copy.
    let forwarded = request;
    if (request.method === "POST") {
      const body = await readCappedText(request, MCP_BODY_LIMIT_BYTES);
      if (body === undefined) {
        return jsonRpcError(
          413,
          ErrorCode.InvalidRequest,
          "Request too large: the body must be at most 64 KB."
        );
      }
      forwarded = new Request(request.url, {
        body,
        headers: request.headers,
        method: "POST",
      });
    }

    const server = buildServer(data, index);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      // The SDK enables stateless mode only when this is `undefined`; `null` is
      // not an accepted value for the `(() => string) | undefined` option.
      // oxlint-disable-next-line sonarjs/no-undefined-assignment
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(forwarded);

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
