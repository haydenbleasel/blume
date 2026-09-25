import { apiNamePhrase } from "../../core/api-name.ts";
import { mountBasePath } from "../../core/base-path.ts";
import { absoluteUrl, siteRoot } from "../../core/site-url.ts";
import {
  API_NAVIGATION_PATH,
  API_PAGE_PATH,
  API_PAGES_PATH,
  API_SEARCH_PATH,
} from "./paths.ts";
import { PROBLEM_TYPE } from "./problem.ts";

/**
 * The OpenAPI 3.1 description of a Blume site's machine-readable surface,
 * served at `/openapi.json`. It documents the JSON docs API (`/api/docs/…`)
 * in full — one `operationId` and description per operation, typed
 * parameters, response schemas, and the RFC 9457 problem shape every error
 * uses — and lists the text surfaces alongside (the `.md` mirrors, `llms.txt`,
 * `llms-full.txt`, `agent-readability.json`) plus the MCP endpoint, so a
 * function-calling framework that ingests OpenAPI gets the same reach an MCP
 * client has. Generated per build from config, so it only describes what the
 * deployed site actually serves.
 */

/** What the document needs to know about the site. */
export interface ApiSpecInput {
  /** Whether `agent-readability.json` is published. */
  agentReadability: boolean;
  /** Normalized `deployment.base` (`""` or `/seg`). */
  base: string;
  description?: string;
  /** Whether `llms.txt`/`llms-full.txt` are published. */
  llmsTxt: boolean;
  /** The MCP server's route, or null when the server is off. */
  mcpRoute: string | null;
  name: string;
  /** Whether the live search endpoint exists (server output only). */
  search: boolean;
  site: string | null;
  /** The generating Blume version — the API contract's version. */
  version: string;
}

/** A schema reference into `components.schemas`. */
interface SchemaRef {
  $ref: string;
}

/** An inline schema, as the text and generic-object responses use. */
interface InlineSchema {
  type: string;
}

interface MediaType {
  schema: InlineSchema | SchemaRef;
}

/** A response object: its description and the media types it may carry. */
interface ResponseObject {
  content?: Record<string, MediaType>;
  description: string;
}

/** A parameter object, as this builder emits it. */
interface Parameter {
  description: string;
  explode?: boolean;
  in: "path" | "query";
  name: string;
  required: boolean;
  schema: object;
  style?: "deepObject" | "form";
}

/** An operation object, as this builder emits it. */
export interface Operation {
  description: string;
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { content: Record<string, MediaType>; required: boolean };
  responses: Record<string, ResponseObject>;
  summary: string;
  tags: string[];
}

/** A path item: the HTTP methods this builder emits. */
export interface PathItem {
  get?: Operation;
  post?: Operation;
}

interface Tag {
  description: string;
  name: string;
}

interface Info {
  description: string;
  title: string;
  version: string;
  "x-generator": string;
}

/** The OpenAPI document, as this builder emits it. */
export interface ApiSpecDocument {
  components: { schemas: typeof schemas };
  externalDocs?: { description: string; url: string };
  info: Info;
  openapi: "3.1.0";
  paths: Record<string, PathItem>;
  security: never[];
  servers: { description: string; url: string }[];
  tags: Tag[];
}

const JSON_TYPE = "application/json";
const EVENT_STREAM_TYPE = "text/event-stream";
const MARKDOWN_TYPE = "text/markdown";
const TEXT_TYPE = "text/plain";

const ref = (name: string): SchemaRef => ({
  $ref: `#/components/schemas/${name}`,
});

const jsonResponse = (description: string, schema: string): ResponseObject => ({
  content: { [JSON_TYPE]: { schema: ref(schema) } },
  description,
});

const problemResponse = (description: string): ResponseObject => ({
  content: { [PROBLEM_TYPE]: { schema: ref("Problem") } },
  description,
});

const textResponse = (description: string, type: string): ResponseObject => ({
  content: { [type]: { schema: { type: "string" } } },
  description,
});

const string = (description: string) => ({ description, type: "string" });

const facetsSchema = {
  additionalProperties: { type: "string" },
  description:
    "Facet values the site declares for the page's content type (`content.types.<type>.facets`), key → value.",
  type: "object",
};

const versionProperty = {
  description:
    'Docs version the page belongs to on a versioned site: `""` for the current docs, else an archived version id. Absent on unversioned sites.',
  type: "string",
};

/** The shared filter parameters of the search operation. */
const searchParameters: Parameter[] = [
  {
    description: "The search query.",
    in: "query",
    name: "q",
    required: true,
    schema: { minLength: 1, type: "string" },
  },
  {
    description: "Maximum hits to return (default 8, at most 20).",
    in: "query",
    name: "limit",
    required: false,
    schema: { default: 8, maximum: 20, minimum: 1, type: "integer" },
  },
  {
    description:
      "Only include pages of these content types (frontmatter `type`, e.g. `doc`, `rfc`). Comma-separated or repeated. Omit for every type.",
    explode: false,
    in: "query",
    name: "contentTypes",
    required: false,
    schema: { items: { type: "string" }, type: "array" },
    style: "form",
  },
  {
    description:
      "Only include pages in this locale (e.g. `fr`). Omit for every language.",
    in: "query",
    name: "locale",
    required: false,
    schema: { type: "string" },
  },
  {
    description:
      "Docs version to scope to on a versioned site: `latest` (the default — current docs only), `all`, or an archived version id. Ignored when the site is unversioned.",
    in: "query",
    name: "version",
    required: false,
    schema: { type: "string" },
  },
  {
    description:
      "Only include pages matching every facet, as `filters[key]=value` pairs (e.g. `filters[status]=enforced`). Facets are metadata the site declares per content type; the page index shows each page's values.",
    explode: true,
    in: "query",
    name: "filters",
    required: false,
    schema: { additionalProperties: { type: "string" }, type: "object" },
    style: "deepObject",
  },
];

const schemas = {
  JsonRpcRequest: {
    description: "A JSON-RPC 2.0 request, as the Model Context Protocol sends.",
    properties: {
      id: { description: "Request id (absent on notifications)." },
      jsonrpc: { const: "2.0", type: "string" },
      method: string("The MCP method, e.g. `initialize` or `tools/call`."),
      params: { description: "Method parameters.", type: "object" },
    },
    required: ["jsonrpc", "method"],
    type: "object",
  },
  JsonRpcResponse: {
    description: "A JSON-RPC 2.0 response: a `result` or an `error`.",
    properties: {
      error: {
        properties: {
          code: { type: "integer" },
          data: {},
          message: { type: "string" },
        },
        required: ["code", "message"],
        type: "object",
      },
      id: {},
      jsonrpc: { const: "2.0", type: "string" },
      result: { type: "object" },
    },
    required: ["jsonrpc"],
    type: "object",
  },
  NavLink: {
    properties: {
      href: string("Link target — an internal route or an external URL."),
      icon: string("Optional icon name."),
      label: { type: "string" },
    },
    required: ["href", "label"],
    type: "object",
  },
  NavNode: {
    description:
      "A sidebar entry: a page (linking to its route) or a group holding further nodes.",
    oneOf: [
      {
        properties: {
          badge: { type: "string" },
          deprecated: { type: "boolean" },
          description: { type: "string" },
          icon: { type: "string" },
          kind: { const: "page", type: "string" },
          label: { type: "string" },
          pageId: string("The page's stable content id."),
          route: string("The page's route."),
        },
        required: ["kind", "label", "pageId", "route"],
        type: "object",
      },
      {
        properties: {
          badge: { type: "string" },
          children: { items: ref("NavNode"), type: "array" },
          collapsed: { type: "boolean" },
          icon: { type: "string" },
          kind: { const: "group", type: "string" },
          label: { type: "string" },
          path: string("The group's route prefix (not necessarily a page)."),
          route: string("The group's index page route, when it has one."),
        },
        required: ["children", "kind", "label"],
        type: "object",
      },
    ],
  },
  NavSelector: {
    description:
      "A top-level partition selector (products, versions, languages).",
    properties: {
      items: {
        items: {
          properties: {
            description: { type: "string" },
            label: { type: "string" },
            path: { type: "string" },
            tag: { type: "string" },
          },
          required: ["label", "path"],
          type: "object",
        },
        type: "array",
      },
      kind: { type: "string" },
      label: { type: "string" },
    },
    required: ["items", "kind", "label"],
    type: "object",
  },
  NavTab: {
    properties: {
      href: string(
        "The clickable target when it differs from `path` (the section's first page)."
      ),
      icon: { type: "string" },
      label: { type: "string" },
      path: string("The tab's section prefix."),
    },
    required: ["label", "path"],
    type: "object",
  },
  Navigation: {
    description:
      "The docs navigation model: header tabs, the sidebar tree, partition selectors, and pinned links.",
    properties: {
      actions: { items: ref("NavLink"), type: "array" },
      cta: { oneOf: [ref("NavLink"), { type: "null" }] },
      featured: { items: ref("NavLink"), type: "array" },
      repoUrl: { type: ["string", "null"] },
      root: string("The tree root's route (`/`, or a locale/version prefix)."),
      selectors: { items: ref("NavSelector"), type: "array" },
      sidebar: { items: ref("NavNode"), type: "array" },
      tabs: { items: ref("NavTab"), type: "array" },
    },
    required: ["featured", "selectors", "sidebar", "tabs"],
    type: "object",
  },
  Page: {
    allOf: [
      ref("PageSummary"),
      {
        properties: {
          markdown: string(
            "The page as agent Markdown: frontmatter included, components downleveled to plain Markdown."
          ),
        },
        required: ["markdown"],
        type: "object",
      },
    ],
    description: "A page's index entry plus its full Markdown body.",
  },
  PageSummary: {
    properties: {
      contentType: string("The page's content type (frontmatter `type`)."),
      description: { type: "string" },
      facets: facetsSchema,
      json: {
        description:
          "This page's JSON representation (the `getPage` operation).",
        format: "uri-reference",
        type: "string",
      },
      lastModified: {
        description: "ISO 8601 last-modified date, when known.",
        type: ["string", "null"],
      },
      locale: string("The page's locale code."),
      markdownUrl: {
        description:
          "The page's raw-Markdown mirror (the `getPageMarkdown` operation).",
        format: "uri-reference",
        type: "string",
      },
      route: string(
        "The page's route (`/guides/install`); the key every other operation takes."
      ),
      title: { type: "string" },
      url: {
        description: "Where the rendered page is served.",
        format: "uri-reference",
        type: "string",
      },
      version: versionProperty,
    },
    required: [
      "contentType",
      "json",
      "lastModified",
      "locale",
      "markdownUrl",
      "route",
      "title",
      "url",
    ],
    type: "object",
  },
  PagesIndex: {
    properties: {
      count: { type: "integer" },
      generator: string("The Blume version that built the site."),
      pages: { items: ref("PageSummary"), type: "array" },
      site: { type: ["string", "null"] },
    },
    required: ["count", "generator", "pages", "site"],
    type: "object",
  },
  Problem: {
    description:
      "RFC 9457 problem details, with a stable code and a resolution hint.",
    properties: {
      code: string("Stable error code (e.g. `PAGE_NOT_FOUND`)."),
      detail: string("Human-readable explanation of this occurrence."),
      instance: string("The request path the problem occurred on."),
      links: {
        description: "Recovery links, when there is somewhere useful to go.",
        items: {
          properties: { href: { type: "string" }, label: { type: "string" } },
          required: ["href", "label"],
          type: "object",
        },
        type: "array",
      },
      resolution: string("What to do next."),
      status: { type: "integer" },
      title: { type: "string" },
      type: string("Problem type URI; `about:blank` by default."),
    },
    required: ["code", "detail", "resolution", "status", "title", "type"],
    type: "object",
  },
  SearchHit: {
    properties: {
      contentType: { type: "string" },
      excerpt: string("The page description, else the start of its content."),
      facets: facetsSchema,
      route: string("The page's route; pass it to `getPage`."),
      title: { type: "string" },
      url: { format: "uri-reference", type: "string" },
      version: versionProperty,
    },
    required: ["excerpt", "route", "title", "url"],
    type: "object",
  },
  SearchResponse: {
    properties: {
      count: { type: "integer" },
      query: { type: "string" },
      results: { items: ref("SearchHit"), type: "array" },
    },
    required: ["count", "query", "results"],
    type: "object",
  },
};

const ROUTE_PARAM: Parameter = {
  description:
    "The page route without its leading slash (`guides/install`), or `index` for the home page. May contain slashes.",
  in: "path",
  name: "route",
  required: true,
  schema: { type: "string" },
};

/** The document's `servers[0].url`: the site origin plus base, or the base. */
const serverUrl = (input: ApiSpecInput): string => {
  if (input.site) {
    return input.base
      ? absoluteUrl(input.site, input.base)
      : siteRoot(input.site);
  }
  return input.base || "/";
};

/** Build the OpenAPI document. Plain data, ready to serialize. */
export const buildApiSpec = (input: ApiSpecInput): ApiSpecDocument => {
  const pathEntries: [string, PathItem][] = [
    [
      API_PAGES_PATH,
      {
        get: {
          description:
            "Every documentation page with its route, title, description, content type, locale, facets, and the URLs of its rendered, Markdown, and JSON forms. Unfiltered; on a versioned site every version is listed with its `version`. Use it to enumerate the docs or to find a page when search is too narrow.",
          operationId: "listPages",
          responses: {
            "200": jsonResponse("The page index.", "PagesIndex"),
            default: problemResponse("An error, as problem details."),
          },
          summary: "List every page",
          tags: ["Pages"],
        },
      },
    ],
    [
      API_PAGE_PATH,
      {
        get: {
          description:
            "A single page as JSON: its index entry plus the page's agent Markdown (frontmatter included, components downleveled to plain Markdown). Take `route` from `listPages` or `searchDocs`.",
          operationId: "getPage",
          parameters: [ROUTE_PARAM],
          responses: {
            "200": jsonResponse("The page.", "Page"),
            "404": problemResponse("No page has that route."),
            default: problemResponse("An error, as problem details."),
          },
          summary: "Get a page as JSON",
          tags: ["Pages"],
        },
      },
    ],
    [
      API_NAVIGATION_PATH,
      {
        get: {
          description:
            "The navigation tree (header tabs and the sidebar hierarchy) as readers see it, for the default locale and the current docs.",
          operationId: "getNavigation",
          responses: {
            "200": jsonResponse("The navigation tree.", "Navigation"),
            default: problemResponse("An error, as problem details."),
          },
          summary: "Get the navigation tree",
          tags: ["Navigation"],
        },
      },
    ],
  ];
  if (input.search) {
    pathEntries.push([
      API_SEARCH_PATH,
      {
        get: {
          description:
            "Full-text search across the documentation. Returns matching pages with their title, route, content type, and a short excerpt; narrow by content type, locale, version, or facet. Use it first to discover relevant pages, then `getPage` to read one in full.",
          operationId: "searchDocs",
          parameters: searchParameters,
          responses: {
            "200": jsonResponse(
              "The matching pages, best first.",
              "SearchResponse"
            ),
            "400": problemResponse("The query was missing or blank."),
            default: problemResponse("An error, as problem details."),
          },
          summary: "Search the docs",
          tags: ["Search"],
        },
      },
    ]);
  }
  pathEntries.push([
    "/{route}.md",
    {
      get: {
        description:
          "A page's raw-Markdown mirror: append `.md` to any page URL. Components are downleveled to plain Markdown; `.mdx` serves the source as written. The same body the `getPage` operation carries in its `markdown` field.",
        operationId: "getPageMarkdown",
        parameters: [ROUTE_PARAM],
        responses: {
          "200": textResponse("The page as Markdown.", MARKDOWN_TYPE),
          "404": textResponse(
            "No page has that route; the body lists where to look next.",
            MARKDOWN_TYPE
          ),
        },
        summary: "Get a page as Markdown",
        tags: ["Markdown"],
      },
    },
  ]);
  if (input.llmsTxt) {
    pathEntries.push(
      [
        "/llms.txt",
        {
          get: {
            description:
              "The llms.txt index: the site's summary, when to use it, and every page with a one-line description, grouped by section.",
            operationId: "getLlmsTxt",
            responses: {
              "200": textResponse("The index.", TEXT_TYPE),
            },
            summary: "Get llms.txt",
            tags: ["Markdown"],
          },
        },
      ],
      [
        "/llms-full.txt",
        {
          get: {
            description:
              "The full Markdown of every current-docs page in one file.",
            operationId: "getLlmsFullTxt",
            responses: {
              "200": textResponse("Every page's Markdown.", TEXT_TYPE),
            },
            summary: "Get llms-full.txt",
            tags: ["Markdown"],
          },
        },
      ]
    );
  }
  if (input.agentReadability) {
    pathEntries.push([
      "/agent-readability.json",
      {
        get: {
          description:
            "A manifest indexing every agent-facing artifact the site publishes — this API, the Markdown mirrors, llms.txt, the MCP server, feeds, and the sitemap.",
          operationId: "getAgentReadability",
          responses: {
            "200": {
              content: { [JSON_TYPE]: { schema: { type: "object" } } },
              description: "The manifest.",
            },
          },
          summary: "Get the agent-readability manifest",
          tags: ["Discovery"],
        },
      },
    ]);
  }
  if (input.mcpRoute) {
    pathEntries.push([
      input.mcpRoute,
      {
        post: {
          description:
            "The Model Context Protocol server (Streamable HTTP, stateless, JSON responses). Send `Accept: application/json, text/event-stream`: the Streamable HTTP transport requires a client to accept both and answers `406` otherwise, though this server always replies with JSON. Tools: `search_docs`, `get_page`, `list_pages`, `get_navigation` — the same operations this API exposes — plus every page as a `text/markdown` resource. Discovery document at `/.well-known/mcp.json`.",
          operationId: "mcp",
          requestBody: {
            content: { [JSON_TYPE]: { schema: ref("JsonRpcRequest") } },
            required: true,
          },
          responses: {
            // Both media types, so a generated client sends the Accept header
            // the transport requires; OpenAPI ignores an `Accept` parameter.
            "200": {
              content: {
                [JSON_TYPE]: { schema: ref("JsonRpcResponse") },
                [EVENT_STREAM_TYPE]: { schema: { type: "string" } },
              },
              description: "The JSON-RPC response.",
            },
            "406": jsonResponse(
              "The request's `Accept` header doesn't list both `application/json` and `text/event-stream`.",
              "JsonRpcResponse"
            ),
          },
          summary: "Call the MCP server",
          tags: ["MCP"],
        },
      },
    ]);
  }

  const tags: Tag[] = [
    { description: "Enumerate and read documentation pages.", name: "Pages" },
    ...(input.search
      ? [{ description: "Full-text search over the docs.", name: "Search" }]
      : []),
    { description: "How the docs are organized.", name: "Navigation" },
    { description: "Plain-text and Markdown surfaces.", name: "Markdown" },
    ...(input.agentReadability
      ? [{ description: "Agent discovery documents.", name: "Discovery" }]
      : []),
    ...(input.mcpRoute
      ? [{ description: "The Model Context Protocol endpoint.", name: "MCP" }]
      : []),
  ];

  const info: Info = {
    description: [
      `Read-only JSON API over the ${input.name} documentation${input.description ? `: ${input.description}` : "."}`,
      "Every operation is public and needs no authentication. Errors are RFC 9457 problem details (`application/problem+json`) with a stable `code`, a `detail`, and a `resolution` hint.",
    ].join("\n\n"),
    title: apiNamePhrase(input.name),
    version: input.version,
    "x-generator": `blume@${input.version}`,
  };
  const document: ApiSpecDocument = {
    components: { schemas },
    info,
    openapi: "3.1.0",
    paths: Object.fromEntries(pathEntries),
    security: [],
    servers: [{ description: input.name, url: serverUrl(input) }],
    tags,
  };
  if (input.site) {
    document.externalDocs = {
      description: `${input.name} documentation`,
      url: absoluteUrl(input.site, mountBasePath(input.base, "/")),
    };
  }
  return document;
};
