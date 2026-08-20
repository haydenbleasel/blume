import type { SearchFn } from "../layout/search/types.ts";
import { joinBase, prefixBase } from "./base-path.ts";

/**
 * WebMCP (W3C Web Machine Learning CG): in-page tools an agentic browser can
 * call, registered on the page's model context. Blume exposes the same
 * read-only surface its hosted MCP server has — search, page Markdown, the
 * docs index — so an agent driving the browser needs no separate connection.
 * The module is inert everywhere else: registration is attempted only when
 * the page exposes a model context.
 */

/** MCP-style tool result: text content, with `isError` on failures. */
interface WebMcpResult {
  content: { text: string; type: "text" }[];
  isError?: boolean;
}

/** A JSON value as a WebMCP agent may supply it in a tool call. */
export type WebMcpJsonValue =
  | boolean
  | number
  | string
  | null
  | WebMcpJsonValue[]
  | { [key: string]: WebMcpJsonValue };

/**
 * Tool arguments exactly as the calling agent supplied them. WebMCP doesn't
 * guarantee schema validation, so each tool checks its own fields at runtime.
 */
export interface WebMcpToolArgs {
  query?: WebMcpJsonValue;
  route?: WebMcpJsonValue;
}

/** The JSON Schema subset these string-argument tools declare. */
export interface WebMcpInputSchema {
  properties: Record<string, { description: string; type: "string" }>;
  required?: string[];
  type: "object";
}

export interface WebMcpTool {
  annotations: { openWorldHint: boolean; readOnlyHint: boolean };
  description: string;
  execute: (input: WebMcpToolArgs) => Promise<WebMcpResult>;
  inputSchema: WebMcpInputSchema;
  name: string;
}

/**
 * The registration surface, in either of the shapes the moving spec has
 * shipped: Chrome's early preview exposes `navigator.modelContext` with
 * `provideContext({ tools })`, while the editor's draft registers tools
 * individually via `registerTool`.
 */
export interface ModelContext {
  provideContext?: (context: { tools: WebMcpTool[] }) => void;
  registerTool?: (tool: WebMcpTool) => void;
}

const text = (value: string, isError = false): WebMcpResult => {
  const result: WebMcpResult = { content: [{ text: value, type: "text" }] };
  if (isError) {
    result.isError = true;
  }
  return result;
};

/** Validates an agent-supplied tool argument before it is used as a string. */
const isString = (value: WebMcpJsonValue | undefined): value is string =>
  typeof value === "string";

/** Detects which registration surface a model context actually implements. */
const isCallable = <T extends (...args: never[]) => void>(
  value: T | undefined
): value is T => typeof value === "function";

const TAG = /<[^>]*>?/gu;

/**
 * Drop the `<mark>` highlighting (and any other markup) search hits carry.
 * The closing `>` is optional so every `<` starts a strip: a dangling
 * `<script` fragment can't survive the way it would if a full `<...>` pair
 * were required. The input is HTML, where a literal `<` is `&lt;`, so
 * consuming from every raw `<` loses nothing legitimate. Stripping repeats
 * to a fixed point so the no-fragment guarantee is explicit rather than an
 * artifact of the regex shape.
 */
const plain = (html: string): string => {
  let stripped = html;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replaceAll(TAG, "");
  } while (stripped !== previous);
  return stripped;
};

export interface WebMcpToolOptions {
  /** The deployment base (`import.meta.env.BASE_URL`). */
  base: string;
  /** Injectable for tests; defaults to the page's `fetch`. */
  fetchFn?: typeof fetch;
  /** Lazy provider-specific search loader (`blume:search-client`). */
  loadSearch: () => Promise<SearchFn>;
  /** Whether the site publishes llms.txt (gates the list tool). */
  llms: boolean;
  /** Whether site search is configured (gates the search tool). */
  search: boolean;
}

/** Build the tool set. Pure — registration is the caller's business. */
export const buildWebMcpTools = (options: WebMcpToolOptions): WebMcpTool[] => {
  const fetchFn = options.fetchFn ?? fetch;
  const readOnly = { openWorldHint: false, readOnlyHint: true };
  const tools: WebMcpTool[] = [];

  if (options.search) {
    // One search instance per page; a transient load failure retries on the
    // next call rather than latching broken.
    let searchFn: SearchFn | null = null;
    tools.push({
      annotations: readOnly,
      description:
        "Full-text search across this documentation site. Returns matching pages with their title, URL, and a short excerpt.",
      async execute(input) {
        const query = isString(input.query) ? input.query : "";
        if (!query.trim()) {
          return text("Provide a non-empty `query` string.", true);
        }
        try {
          searchFn ??= await options.loadSearch();
          const { hits } = await searchFn(query);
          if (hits.length === 0) {
            return text(`No results for "${query}".`);
          }
          return text(
            hits
              .map(
                (hit) =>
                  `${plain(hit.title)} — ${prefixBase(options.base, hit.url)}\n${plain(hit.excerpt)}`
              )
              .join("\n\n")
          );
        } catch {
          searchFn = null;
          return text("Search is unavailable right now.", true);
        }
      },
      inputSchema: {
        properties: {
          query: { description: "The search query.", type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search_docs",
    });
  }

  tools.push({
    annotations: readOnly,
    description:
      "Fetch a page of this site as plain Markdown. Pass the page's root-relative route, e.g. `/quickstart`.",
    async execute(input) {
      const route = isString(input.route) ? input.route : "";
      if (!route.startsWith("/")) {
        return text("Pass a root-relative route, e.g. `/quickstart`.", true);
      }
      const trimmed = route.length > 1 ? route.replace(/\/+$/u, "") : route;
      const target = trimmed === "/" ? "/index" : trimmed;
      const response = await fetchFn(
        `${prefixBase(options.base, target)}.md`
      ).catch(() => null);
      if (!response?.ok) {
        return text(`No Markdown found for ${route}.`, true);
      }
      return text(await response.text());
    },
    inputSchema: {
      properties: {
        route: {
          description: "Root-relative page route, e.g. `/quickstart`.",
          type: "string",
        },
      },
      required: ["route"],
      type: "object",
    },
    name: "get_page",
  });

  if (options.llms) {
    tools.push({
      annotations: readOnly,
      description:
        "List this site's pages: the llms.txt index of every page with its URL and summary, organized by section.",
      async execute() {
        const response = await fetchFn(
          joinBase(options.base, "llms.txt")
        ).catch(() => null);
        if (!response?.ok) {
          return text("The page index (llms.txt) is unavailable.", true);
        }
        return text(await response.text());
      },
      inputSchema: { properties: {}, type: "object" },
      name: "list_pages",
    });
  }

  return tools;
};

/**
 * Register the tools on whichever model context the page exposes. Returns
 * whether a registration surface was found — false in every browser that
 * doesn't implement WebMCP, which is the common, silent case.
 */
export const registerWebMcpTools = (
  tools: WebMcpTool[],
  context?: ModelContext | null
): boolean => {
  if (!context) {
    return false;
  }
  if (isCallable(context.provideContext)) {
    context.provideContext({ tools });
    return true;
  }
  if (isCallable(context.registerTool)) {
    for (const tool of tools) {
      context.registerTool(tool);
    }
    return true;
  }
  return false;
};
