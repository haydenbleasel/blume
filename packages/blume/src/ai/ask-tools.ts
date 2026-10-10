import { jsonSchema, tool } from "ai";

import { normalizeRoute } from "../core/base-path.ts";
import { queryOramaIndex } from "../search/orama-index.ts";
import type { OramaDoc } from "../search/orama-index.ts";
import {
  askIndex,
  excerptHeading,
  readerScope,
  sectionExcerpt,
} from "./ask-context.ts";
import type { AskData, AskPage, ReaderScope } from "./ask-context.ts";

/**
 * The assistant's docs tools: what lets it look beyond the excerpts the
 * endpoint injects up front. `search_docs` runs the same Orama search the
 * grounding does, scoped to the reader's language and docs version;
 * `read_page` returns a whole page, for when an excerpt stops short of the
 * answer. Both read the assistant snapshot the endpoint already imports, so
 * they add no build output and no network call.
 *
 * The generated `/api/ask` route passes them to `streamText` with a step cap
 * ({@link ASK_MAX_STEPS}), so the model can search, read, and then answer
 * within one request.
 */

/**
 * The most model steps one answer may take: up to four rounds of tool calls,
 * then the answer. Enough to search, read a page or two, and search again,
 * while bounding what one question can spend.
 */
export const ASK_MAX_STEPS = 5;

/** Pages one search returns. */
const SEARCH_RESULTS = 5;

/** Characters of each search result's most relevant excerpt. */
const SEARCH_EXCERPT_CHARS = 700;

/** Characters of a page `read_page` returns; a longer page is cut here. */
const PAGE_CHARS = 20_000;

/** A result block, headed the way the injected excerpts are, for citing. */
const block = (doc: OramaDoc, body: string): string =>
  `${excerptHeading(doc)}\n${body}`;

/**
 * Search the docs for `query` within the reader's scope: the most relevant
 * excerpt of each of the top pages, or a note that nothing matched.
 */
export const searchDocs = async (
  data: AskData,
  scope: ReaderScope,
  query: string
): Promise<string> => {
  const hits = await queryOramaIndex(
    await askIndex(data),
    query,
    SEARCH_RESULTS,
    scope.filters
  );
  if (hits.length === 0) {
    return `No pages matched "${query}". Try other words, or a broader query.`;
  }
  return hits
    .map((doc) =>
      block(doc, sectionExcerpt(doc.content, query, SEARCH_EXCERPT_CHARS))
    )
    .join("\n\n");
};

/**
 * The route a model asked for, as the snapshot keys it: a full URL on the
 * site becomes its path, a query string or fragment is dropped, and
 * percent-escapes are decoded (a cited route escapes whitespace and
 * parentheses; see `excerptHeading`).
 */
const routeOf = (data: AskData, requested: string): string => {
  let path = requested.trim();
  if (data.site && path.startsWith(data.site)) {
    path = path.slice(data.site.replace(/\/$/u, "").length) || "/";
  }
  path = path.replace(/[?#].*$/u, "");
  try {
    path = decodeURI(path);
  } catch {
    // Malformed percent sequence — look it up as written.
  }
  return normalizeRoute(path.startsWith("/") ? path : `/${path}`);
};

/** A whole page by route, cut at {@link PAGE_CHARS}, or a note that it doesn't exist. */
export const readPage = (
  data: AskData,
  byRoute: ReadonlyMap<string, OramaDoc>,
  requested: string
): string => {
  const route = routeOf(data, requested);
  const doc = byRoute.get(route);
  if (!doc) {
    return `There is no page at ${route}. Use search_docs to find the right one.`;
  }
  const text =
    doc.content.length > PAGE_CHARS
      ? `${doc.content.slice(0, PAGE_CHARS)}\n\n[The page continues; this is its first ${PAGE_CHARS.toLocaleString("en-US")} characters.]`
      : doc.content;
  return block(doc, text);
};

/**
 * The tools for one request, given the page the reader is on. Built per
 * request because the search scope follows the reader's locale and version.
 */
export const createAskTools = (data: AskData) => {
  const byRoute = new Map(data.documents.map((doc) => [doc.route, doc]));
  return (page?: AskPage) => {
    const scope = readerScope(data, byRoute, page);
    return {
      read_page: tool({
        description:
          "Read one documentation page in full, by its route (the link target in the heading that opens a page's excerpt, such as /docs/getting-started).",
        execute: ({ route }) => Promise.resolve(readPage(data, byRoute, route)),
        inputSchema: jsonSchema<{ route: string }>({
          additionalProperties: false,
          properties: {
            route: {
              description: "The page's route, such as /docs/getting-started.",
              type: "string",
            },
          },
          required: ["route"],
          type: "object",
        }),
      }),
      search_docs: tool({
        description:
          "Search this project's documentation. Returns the most relevant excerpt of each matching page, headed by a Markdown link to the page.",
        execute: ({ query }) => searchDocs(data, scope, query),
        inputSchema: jsonSchema<{ query: string }>({
          additionalProperties: false,
          properties: {
            query: {
              description:
                "A few focused keywords, such as the feature or option the question is about.",
              type: "string",
            },
          },
          required: ["query"],
          type: "object",
        }),
      }),
    };
  };
};
