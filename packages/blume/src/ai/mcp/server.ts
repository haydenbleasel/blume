import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  normalizeRoute as normalizePageRoute,
  stripBasePath,
  withBasePath,
} from "../../core/base-path.ts";
import { absoluteUrl } from "../../core/site-url.ts";
import { trimEnd } from "../../core/trim.ts";
import { buildOramaIndex, queryOramaIndex } from "../../search/orama-index.ts";
import type { OramaDoc } from "../../search/orama-index.ts";
import type { McpData } from "./data.ts";
import { MCP_TOOLS } from "./tools.ts";

/**
 * The low-level SDK `Server` is used (rather than the high-level `McpServer`)
 * because the latter's `registerTool` is generic over the caller's Zod instance;
 * Blume's zod and the SDK's may resolve to different copies, whose types don't
 * unify. Each tool's input is defined once in Blume's own zod: the runtime
 * parse and the JSON Schema advertised by `tools/list` (via `z.toJSONSchema`)
 * derive from the same definition, so they cannot drift.
 */

/** Default and maximum number of hits returned by `search_docs`. */
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
/** Excerpt length when a page has no description. */
const EXCERPT_LENGTH = 200;

const CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

// Each field is a preprocess pipe: the input side accepts the sloppy shapes
// LLM callers actually send (a bare string for an array field, `[]`/`{}`
// meaning "no filter", out-of-range limits clamped rather than rejected), and
// the pipe's *output* side is the clean shape — which is exactly what
// `z.toJSONSchema` emits for `tools/list`. No coercion can ever fail, so a
// tool call is never rejected on argument shape, matching the previous
// hand-rolled coercions.

/**
 * The optional content-type filter `search_docs` and `list_pages` share.
 * `[]` or no usable strings mean "no filter", not "match nothing"; a bare
 * string is accepted as a one-element list.
 */
const contentTypesField = z.preprocess((value) => {
  const list = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string => typeof entry === "string"
  );
  return list.length > 0 ? list : undefined;
}, z.array(z.string()).optional().describe('Only include pages of these content types (frontmatter `type`, e.g. `["doc", "rfc"]`). `list_pages` shows each page\'s type. Omit to include every type.'));

/**
 * The optional facet filter `search_docs` and `list_pages` share. Only
 * string-valued entries survive; an empty `{}` means "no filter".
 */
/** Accepts any plain object, so the string-valued entries can be sifted out. */
const looseFacetObject = z.record(z.string(), z.unknown());

const filtersField = z.preprocess((value) => {
  const candidate = looseFacetObject.safeParse(value);
  if (!candidate.success) {
    return;
  }
  const entries = Object.entries(candidate.data).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}, z.record(z.string(), z.string()).optional().describe('Only include pages matching every facet, key → required value (e.g. `{"status": "enforced"}`). Facets are metadata the site declares per content type; `list_pages` shows each page\'s facet values. Omit for no facet filtering.'));

/** Clamped into range rather than rejected; non-numeric means the default. */
const limitField = z.preprocess(
  (value) => {
    // `Number` is the identity on numbers, so one conversion covers both the
    // well-typed call and a numeric string.
    const num = Number(value);
    return Number.isFinite(num)
      ? Math.min(Math.max(Math.trunc(num), 1), MAX_SEARCH_LIMIT)
      : undefined;
  },
  z
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`Maximum hits to return (default ${DEFAULT_SEARCH_LIMIT}).`)
);

/** A required text field; a missing or non-string value coerces to "". */
const textField = (description: string) =>
  z.preprocess((value) => {
    const parsed = z.string().safeParse(value);
    return parsed.success ? parsed.data : "";
  }, z.string().describe(description));

/** An optional trimmed text field; blank or non-string means "absent". */
const optionalTextField = (description: string) =>
  z.preprocess((value) => {
    const parsed = z.string().safeParse(value);
    const trimmed = parsed.success ? parsed.data.trim() : "";
    return trimmed || undefined;
  }, z.string().optional().describe(description));

/** The optional locale filter `search_docs` and `list_pages` share. */
const localeField = optionalTextField(
  "Only include pages in this locale (e.g. `fr`). Omit for every language."
);

/** The optional docs-version scope `search_docs` and `list_pages` share. */
const versionField = optionalTextField(
  'Docs version to scope to on a versioned site: `"latest"` (the default — current docs only), `"all"` (every version), or an archived version id (e.g. `"v1.0"`). Ignored when the site is unversioned.'
);

/** Every tool's input schema — the runtime parse and tools/list source. */
const TOOL_INPUTS = {
  get_navigation: z.object({
    locale: optionalTextField(
      "Locale whose navigation tree to return (defaults to the default locale)."
    ),
    version: optionalTextField(
      "Archived version id whose tree to return (defaults to the current docs)."
    ),
  }),
  get_page: z.object({
    route: textField("The page route, e.g. `/guides/install`."),
  }),
  list_pages: z.object({
    contentTypes: contentTypesField,
    filters: filtersField,
    locale: localeField,
    version: versionField,
  }),
  search_docs: z.object({
    contentTypes: contentTypesField,
    filters: filtersField,
    limit: limitField,
    locale: localeField,
    query: textField("The search query."),
    version: versionField,
  }),
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

/** One `search_docs` result entry; `version` only appears on versioned sites. */
interface SearchHitPayload {
  contentType: string | undefined;
  excerpt: string;
  facets: Record<string, string> | undefined;
  route: string;
  title: string;
  url: string;
  version?: string;
}

/** One `list_pages` entry; `version` only appears on versioned sites. */
interface PageListingPayload {
  contentType: string;
  description: string | undefined;
  facets: Record<string, string> | undefined;
  lastModified: string | null;
  route: string;
  title: string;
  url: string;
  version?: string;
}

/** Whether a page's facet values satisfy every requested filter entry. */
const matchesFacets = (
  facets: Record<string, string> | undefined,
  filters: Record<string, string>
): boolean =>
  Object.entries(filters).every(([key, value]) => facets?.[key] === value);

/**
 * Resolve the `version` scope on a versioned site: `undefined` disables the
 * filter (`"all"`), `""` is the current docs (the default — agents almost
 * always want the live documentation), and anything else is an archived id
 * (an unknown id simply matches nothing). On an unversioned site the input is
 * ignored entirely. The input arrives pre-trimmed (blank coerced to absent)
 * from the tool's input schema.
 */
const asVersionScope = (
  value: string | undefined,
  data: McpData
): string | undefined => {
  if (!data.archivedVersions) {
    return;
  }
  if (value === "all") {
    return;
  }
  if (value === undefined || value === "latest" || value === "current") {
    return "";
  }
  return value;
};

/**
 * Error message for a `get_navigation` version id that isn't a configured
 * archived version, or `null` when the id is valid (or the site is
 * unversioned, where the id is ignored like the other tools' scopes). Unlike
 * `asVersionScope`'s match-nothing filters, a bad id here would otherwise
 * silently return the *current* tree posing as the requested snapshot.
 */
const unknownVersionError = (
  versionId: string | undefined,
  data: McpData
): string | null =>
  versionId &&
  data.archivedVersions &&
  !data.archivedVersions.includes(versionId)
    ? `Unknown version "${versionId}". Archived versions: ${data.archivedVersions.join(", ")}.`
    : null;

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
  // Trailing slashes come off before the suffix so `/a/b.md/` still loses its
  // `.md`; normalizePageRoute then settles the leading slash.
  const noSuffix = trimEnd(value, "/").replace(/\.mdx?$/u, "");
  return stripBasePath(data.base, normalizePageRoute(noSuffix));
};

/** Build the absolute (or root-relative) URL for a route. */
const urlFor = (route: string, data: McpData): string => {
  // Routes are base-less manifest paths; layer `deployment.base` on top so the
  // URL matches where the page is served (the sitemap/llms.txt convention).
  const path = withBasePath(data.base, route);
  // Concatenate rather than `new URL(path, site)` — a root-absolute path
  // would drop the base path of a subpath deployment (`acme.com/docs`).
  return data.site ? absoluteUrl(data.site, path) : path;
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

/** A tool call's text result, marked as an error when `isError` is set. */
const text = (value: string, isError = false) => {
  const content = [{ text: value, type: "text" as const }];
  return isError ? { content, isError: true } : { content };
};

/** Lazily builds the Orama index over a snapshot's documents, once. */
export type OramaIndexProvider = () => Promise<
  Awaited<ReturnType<typeof buildOramaIndex>>
>;

/**
 * Memoize the search index so every server built from a snapshot shares it.
 * `locale` is the snapshot's `defaultLocale`, forwarded so non-Latin scripts
 * (Japanese and Chinese, but equally Cyrillic, Greek, Hebrew, Devanagari…)
 * get a word-segmenting tokenizer.
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
  const serverOptions: ServerOptions = data.instructions
    ? { capabilities: { tools: {} }, instructions: data.instructions }
    : { capabilities: { tools: {} } };
  const server = new Server(
    { name: data.name, version: data.version },
    serverOptions
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { arguments: args = {}, name } = request.params;

    if (name === "search_docs") {
      const input = TOOL_INPUTS.search_docs.parse(args);
      const db = await index();
      const hits = await queryOramaIndex(
        db,
        input.query,
        input.limit ?? DEFAULT_SEARCH_LIMIT,
        {
          contentTypes: input.contentTypes,
          facets: input.filters,
          locale: input.locale,
          version: asVersionScope(input.version, data),
        }
      );
      // `route` is the key `get_page` takes (the tool descriptions promise
      // it); `url` is where the page is served.
      const results = hits.map((doc: OramaDoc) => {
        const hit: SearchHitPayload = {
          contentType: doc.contentType,
          excerpt: excerptFor(doc),
          facets: doc.facets,
          route: doc.route,
          title: doc.title,
          url: urlFor(doc.route, data),
        };
        if (data.archivedVersions) {
          hit.version = doc.version ?? "";
        }
        return hit;
      });
      return text(JSON.stringify(results, null, 2));
    }

    if (name === "get_page") {
      const input = TOOL_INPUTS.get_page.parse(args);
      const key = normalizeRoute(input.route, data);
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
      const input = TOOL_INPUTS.list_pages.parse(args);
      const { contentTypes, filters, locale } = input;
      const versionScope = asVersionScope(input.version, data);
      const routes = data.routes.filter(
        (route) =>
          (!contentTypes || contentTypes.includes(route.contentType)) &&
          (!filters || matchesFacets(route.facets, filters)) &&
          (!locale || route.locale === locale) &&
          (versionScope === undefined || route.version === versionScope)
      );
      return text(
        JSON.stringify(
          routes.map((route) => {
            const listing: PageListingPayload = {
              contentType: route.contentType,
              description: route.description,
              facets: route.facets,
              lastModified: route.lastModified,
              route: route.route,
              title: route.title,
              url: urlFor(route.route, data),
            };
            if (data.archivedVersions) {
              listing.version = route.version;
            }
            return listing;
          }),
          null,
          2
        )
      );
    }

    if (name === "get_navigation") {
      // A version id selects the snapshot's tree; a locale selects its
      // language (falling back through the default locale to any tree the
      // snapshot has). Without a version, a locale selects the current docs'
      // localized tree. An unknown id on a versioned site is an error — the
      // current tree would silently masquerade as the requested snapshot.
      const { locale, version: versionId } =
        TOOL_INPUTS.get_navigation.parse(args);
      const unknownVersion = unknownVersionError(versionId, data);
      if (unknownVersion) {
        return text(unknownVersion, true);
      }
      let { navigation } = data;
      const byLocale = versionId
        ? data.navigationByVersion?.[versionId]
        : undefined;
      if (byLocale) {
        navigation =
          (locale ? byLocale[locale] : undefined) ??
          byLocale[data.defaultLocale ?? ""] ??
          Object.values(byLocale)[0] ??
          navigation;
      } else if (locale && data.navigationByLocale?.[locale]) {
        navigation = data.navigationByLocale[locale];
      }
      return text(JSON.stringify(navigation, null, 2));
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
