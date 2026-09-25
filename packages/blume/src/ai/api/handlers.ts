import { mountBasePath } from "../../core/base-path.ts";
import { absoluteUrl } from "../../core/site-url.ts";
import type { Navigation } from "../../core/types.ts";
import type { McpData, McpRoute } from "../mcp/data.ts";
import {
  createIndexProvider,
  getPageMarkdown,
  searchDocs,
  TOOL_INPUTS,
  urlFor,
} from "../mcp/query.ts";
import type { SearchHitPayload } from "../mcp/query.ts";
import {
  API_PAGES_PATH,
  API_SEARCH_PATH,
  OPENAPI_PATH,
  pageJsonPath,
  pageParam,
} from "./paths.ts";
import { problemResponse } from "./problem.ts";

/**
 * The JSON docs API: the REST twin of the MCP tools, over the same snapshot
 * and the same operations (`mcp/query.ts`). The page index, per-page JSON,
 * and navigation are prerendered, so a static site serves them from files;
 * search is a live endpoint and exists on server output only. Errors are RFC
 * 9457 problem details (`problem.ts`). The generated endpoints under
 * `.blume/src/pages/api/docs/` are thin wrappers around these.
 */

/** One page in the index; `version` only appears on versioned sites. */
export interface ApiPageSummary {
  contentType: string;
  description?: string;
  facets?: Record<string, string>;
  /** The page's JSON representation (this API's `getPage`). */
  json: string;
  lastModified: string | null;
  locale: string;
  /** The page's raw-Markdown mirror (`{route}.md`). */
  markdownUrl: string;
  route: string;
  title: string;
  /** Where the rendered page is served. */
  url: string;
  version?: string;
}

/** The `pages.json` document. */
export interface ApiPagesIndex {
  count: number;
  generator: string;
  pages: ApiPageSummary[];
  site: string | null;
}

/** A page's JSON representation: its index entry plus the agent Markdown. */
export interface ApiPage extends ApiPageSummary {
  markdown: string;
}

/** The search endpoint's document. */
export interface ApiSearchResponse {
  count: number;
  query: string;
  results: SearchHitPayload[];
}

/** The site + base an endpoint needs to build absolute URLs. */
export interface ApiSiteContext {
  base: string;
  site: string | null;
}

/** What the API serializes: one of its documents, or the navigation tree. */
export type ApiPayload =
  | ApiPage
  | ApiPagesIndex
  | ApiSearchResponse
  | Navigation;

/** A `Response` carrying JSON, pretty-printed for the humans who curl it. */
export const jsonResponse = (payload: ApiPayload, status = 200): Response =>
  new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    status,
  });

/** The absolute (or root-relative) URL for a base-less path. */
const siteUrl = (path: string, context: ApiSiteContext): string => {
  const based = mountBasePath(context.base, path);
  return context.site ? absoluteUrl(context.site, based) : based;
};

const summarize = (route: McpRoute, data: McpData): ApiPageSummary => {
  const summary: ApiPageSummary = {
    contentType: route.contentType,
    json: siteUrl(pageJsonPath(route.route), data),
    lastModified: route.lastModified,
    locale: route.locale,
    markdownUrl: siteUrl(`/${pageParam(route.route)}.md`, data),
    route: route.route,
    title: route.title,
    url: urlFor(route.route, data),
  };
  if (route.description !== undefined) {
    summary.description = route.description;
  }
  if (route.facets) {
    summary.facets = route.facets;
  }
  if (data.archivedVersions) {
    summary.version = route.version;
  }
  return summary;
};

/** Every non-hidden page, in manifest order; the index is unfiltered. */
export const buildPagesIndex = (data: McpData): ApiPagesIndex => {
  const pages = data.routes.map((route) => summarize(route, data));
  return {
    count: pages.length,
    generator: `blume@${data.version}`,
    pages,
    site: data.site,
  };
};

export const pagesIndexResponse = (data: McpData): Response =>
  jsonResponse(buildPagesIndex(data));

/**
 * `getStaticPaths` entries for the per-page endpoint: one per route that has
 * agent Markdown to serve (a landing page without a mirror has no JSON twin
 * either).
 */
export const pageParams = (
  data: McpData
): { params: { route: string }; props: { route: string } }[] =>
  data.routes
    .filter((route) => getPageMarkdown(data, route.route) !== undefined)
    .map((route) => ({
      params: { route: pageParam(route.route) },
      props: { route: route.route },
    }));

/** A page's JSON document, or null when no page has the route. */
export const buildPage = (data: McpData, route: string): ApiPage | null => {
  const entry = data.routes.find((candidate) => candidate.route === route);
  const markdown = getPageMarkdown(data, route);
  if (!entry || markdown === undefined) {
    return null;
  }
  return { ...summarize(entry, data), markdown };
};

/** The 404 for a route no page has, at its per-page JSON path. */
const pageNotFoundResponse = (
  route: string,
  context: ApiSiteContext
): Response =>
  problemResponse({
    code: "PAGE_NOT_FOUND",
    detail: `No documentation page has the route "${route}".`,
    instance: siteUrl(pageJsonPath(route), context),
    resolution: `List every page at ${siteUrl(API_PAGES_PATH, context)}, or discover the API through ${siteUrl(OPENAPI_PATH, context)}.`,
    status: 404,
    title: "Page not found",
  });

export const pageResponse = (data: McpData, route: string): Response => {
  const page = buildPage(data, route);
  return page ? jsonResponse(page) : pageNotFoundResponse(route, data);
};

const PAGE_JSON_PATH = /^\/api\/docs\/pages\/(?<param>.+)\.json$/u;

/**
 * The route a base-less `pages/{route}.json` path asks for (`index` is the
 * home page), or `undefined` for any other path.
 */
const requestedPageRoute = (path: string): string | undefined => {
  const param = PAGE_JSON_PATH.exec(path)?.groups?.param;
  if (param === undefined) {
    return undefined;
  }
  let decoded = param;
  try {
    decoded = decodeURIComponent(param);
  } catch {
    // A malformed escape names no page either; report it as written.
  }
  return decoded === "index" ? "/" : `/${decoded}`;
};

/** The default navigation tree (default locale, current docs). */
export const buildNavigation = (data: McpData): Navigation => data.navigation;

export const navigationResponse = (data: McpData): Response =>
  jsonResponse(buildNavigation(data));

/** Repeated and comma-separated values of a list query parameter. */
const listParam = (
  params: URLSearchParams,
  key: string
): string[] | undefined => {
  const values = params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
};

const FILTER_PARAM = /^filters\[(?<key>.+)\]$/u;

/** The `filters[key]=value` (OpenAPI deepObject) facet filters. */
const filtersParam = (
  params: URLSearchParams
): Record<string, string> | undefined => {
  const entries: [string, string][] = [];
  for (const [key, value] of params) {
    const facet = FILTER_PARAM.exec(key)?.groups?.key;
    if (facet) {
      entries.push([facet, value]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/**
 * The live search endpoint: `GET /api/docs/search?q=…`. Runs the same query
 * `search_docs` runs, over an index built once per snapshot and shared across
 * requests. A missing or blank `q` is a 400 problem.
 */
export const createSearchHandler = (
  data: McpData
): ((request: Request) => Promise<Response>) => {
  const index = createIndexProvider(data.documents, data.defaultLocale);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const params = url.searchParams;
    const query = (params.get("q") ?? "").trim();
    if (!query) {
      return problemResponse({
        code: "MISSING_QUERY",
        detail: 'The "q" query parameter is required and must not be blank.',
        instance: url.pathname,
        resolution: `Repeat the request with ?q=<search terms>, e.g. ${siteUrl(API_SEARCH_PATH, data)}?q=install.`,
        status: 400,
        title: "Missing search query",
      });
    }
    const input = TOOL_INPUTS.search_docs.parse({
      contentTypes: listParam(params, "contentTypes"),
      filters: filtersParam(params),
      limit: params.get("limit") ?? undefined,
      locale: params.get("locale") ?? undefined,
      query,
      version: params.get("version") ?? undefined,
    });
    const results = await searchDocs(data, index, input);
    const payload: ApiSearchResponse = {
      count: results.length,
      query,
      results,
    };
    return jsonResponse(payload);
  };
};

/**
 * The 404 for anything under `/api/` that no endpoint answers — the catch-all
 * behind every live route on server output, so an agent probing the API
 * namespace gets a problem document instead of the HTML not-found page. A
 * `pages/{route}.json` miss gets the per-page `PAGE_NOT_FOUND` problem.
 */
export const apiNotFoundResponse = (
  request: Request,
  context: ApiSiteContext
): Response => {
  const { pathname } = new URL(request.url);
  // Per-page JSON is prerendered, so a route no page has falls through to
  // this catch-all on server output; answer it as the page miss it is.
  const baseless =
    context.base && pathname.startsWith(`${context.base}/`)
      ? pathname.slice(context.base.length)
      : pathname;
  const route = requestedPageRoute(baseless);
  if (route !== undefined) {
    return pageNotFoundResponse(route, context);
  }
  return problemResponse({
    code: "API_ROUTE_NOT_FOUND",
    detail: `No API route exists at ${pathname}.`,
    instance: pathname,
    links: [
      { href: siteUrl(OPENAPI_PATH, context), label: "OpenAPI description" },
      { href: siteUrl(API_PAGES_PATH, context), label: "Page index" },
    ],
    resolution: `Discover the available operations through the OpenAPI description at ${siteUrl(OPENAPI_PATH, context)}, or list every page at ${siteUrl(API_PAGES_PATH, context)}.`,
    status: 404,
    title: "API route not found",
  });
};
