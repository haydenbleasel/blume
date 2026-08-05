import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { stripBasePath, withBasePath } from "../../core/base-path.ts";
import { buildOramaIndex, queryOramaIndex } from "../../search/orama-index.ts";
import type { OramaDoc } from "../../search/orama-index.ts";
import type { McpData } from "./data.ts";
import { MCP_TOOLS } from "./tools.ts";

/**
 * The low-level SDK `Server` is used (rather than the high-level `McpServer`)
 * because the latter's `registerTool` is generic over the caller's Zod instance;
 * Blume's zod and the SDK's may resolve to different copies, whose types don't
 * unify. Hand-written JSON Schema and the SDK's own request schemas avoid that
 * entirely.
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

/** The optional content-type filter `search_docs` and `list_pages` share. */
const CONTENT_TYPES_SCHEMA = {
  description:
    'Only include pages of these content types (frontmatter `type`, e.g. `["doc", "rfc"]`). `list_pages` shows each page\'s type. Omit to include every type.',
  items: { type: "string" },
  type: "array",
} as const;

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
  list_pages: {
    properties: { contentTypes: CONTENT_TYPES_SCHEMA },
    type: "object",
  },
  search_docs: {
    properties: {
      contentTypes: CONTENT_TYPES_SCHEMA,
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

/**
 * The `contentTypes` filter as a string array, or `undefined` when absent or
 * empty — an agent sending `[]` means "no filter", not "match nothing". A bare
 * string is accepted as a one-element list.
 */
const asContentTypes = (value: unknown): string[] | undefined => {
  const list = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [value].filter((entry): entry is string => typeof entry === "string");
  return list.length > 0 ? list : undefined;
};

const asLimit = (value: unknown): number => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(num), 1), MAX_SEARCH_LIMIT);
};

/**
 * Normalize a user-supplied route to a `pages` key (`/`, `/a/b`, no suffix).
 * Accepts a full URL too — `search_docs` hits and llms.txt entries carry
 * `site` + `deployment.base`, and an agent following "pass a route from
 * `search_docs`" will hand one straight back — reducing it to its base-less,
 * percent-decoded path.
 */
const normalizeRoute = (input: string, data: McpData): string => {
  let value = input.trim();
  if (/^https?:\/\//iu.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      // Not parseable as a URL after all; treat it as a path.
    }
  }
  try {
    value = decodeURI(value);
  } catch {
    // Malformed percent sequence — compare it as written.
  }
  const noTrailing = value.replace(/\/+$/u, "");
  const noSuffix = noTrailing.replace(/\.mdx?$/u, "");
  const withSlash = noSuffix.startsWith("/") ? noSuffix : `/${noSuffix}`;
  const based = stripBasePath(data.base, withSlash);
  return based === "" ? "/" : based;
};

/** Build the absolute (or root-relative) URL for a route. */
const urlFor = (route: string, data: McpData): string => {
  // Routes are base-less manifest paths; layer `deployment.base` on top so the
  // URL matches where the page is served (the sitemap/llms.txt convention).
  const path = withBasePath(data.base, route);
  // Concatenate rather than `new URL(path, site)` — a root-absolute path
  // would drop the base path of a subpath deployment (`acme.com/docs`).
  return data.site ? `${data.site.replace(/\/+$/u, "")}${path}` : path;
};

/** A hit's excerpt: its description, else the head of its content with an
 * ellipsis only when something was actually cut off. */
const excerptFor = (doc: OramaDoc): string => {
  if (doc.description) {
    return doc.description;
  }
  const head = doc.content.slice(0, EXCERPT_LENGTH).trim();
  return doc.content.length > EXCERPT_LENGTH ? `${head}…` : head;
};

const text = (value: string, isError = false) => ({
  content: [{ text: value, type: "text" as const }],
  ...(isError ? { isError: true } : {}),
});

/** Lazily builds the Orama index over a snapshot's documents, once. */
export type OramaIndexProvider = () => Promise<
  Awaited<ReturnType<typeof buildOramaIndex>>
>;

/**
 * Memoize the search index so every server built from a snapshot shares it.
 * `locale` is the snapshot's `defaultLocale`, forwarded so unspaced scripts
 * (Japanese, Chinese, Korean, Thai) get a word-segmenting tokenizer.
 */
export const createIndexProvider = (
  documents: OramaDoc[],
  locale?: string
): OramaIndexProvider => {
  let dbPromise: ReturnType<OramaIndexProvider> | null = null;
  return function provideIndex() {
    dbPromise ??= buildOramaIndex(documents, locale);
    return dbPromise;
  };
};

/** Construct a fresh MCP server with Blume's read-only docs tools registered. */
export const buildServer = (
  data: McpData,
  index: OramaIndexProvider
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
        asLimit(args.limit),
        { contentTypes: asContentTypes(args.contentTypes) }
      );
      // `route` is the key `get_page` takes (the tool descriptions promise
      // it); `url` is where the page is served.
      const results = hits.map((doc: OramaDoc) => ({
        contentType: doc.contentType,
        excerpt: excerptFor(doc),
        route: doc.route,
        title: doc.title,
        url: urlFor(doc.route, data),
      }));
      return text(JSON.stringify(results, null, 2));
    }

    if (name === "get_page") {
      const key = normalizeRoute(asString(args.route), data);
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
      const contentTypes = asContentTypes(args.contentTypes);
      const routes = contentTypes
        ? data.routes.filter((route) =>
            contentTypes.includes(route.contentType)
          )
        : data.routes;
      return text(
        JSON.stringify(
          routes.map((route) => ({
            contentType: route.contentType,
            description: route.description,
            lastModified: route.lastModified,
            route: route.route,
            title: route.title,
            url: urlFor(route.route, data),
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

    const server = buildServer(data, index);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      // The SDK enables stateless mode only when this is `undefined`; `null` is
      // not an accepted value for the `(() => string) | undefined` option.
      // oxlint-disable-next-line sonarjs/no-undefined-assignment
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
