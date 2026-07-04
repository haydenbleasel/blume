import { buildOramaIndex, queryOramaIndex } from "../search/orama-index.ts";
import type { OramaDoc } from "../search/orama-index.ts";

/** A chat message as posted by the Ask AI island (`{ role, content }`). */
export interface AskMessage {
  content: string;
  role: string;
}

/** The current-page hint the island forwards so the endpoint can prioritize it. */
export interface AskPage {
  path?: string;
}

/**
 * The self-contained snapshot the grounded Ask AI endpoint imports. Bundles the
 * search documents so retrieval works regardless of the configured search
 * provider and needs no filesystem access at request time. Serialized to
 * `generated/ask-data.json` and built by {@link buildAskData}.
 */
export interface AskData {
  documents: OramaDoc[];
  site: string | null;
}

/** Documents retrieved per question and injected into the system prompt. */
const MAX_RESULTS = 6;
/** Characters kept per injected excerpt. */
const EXCERPT_CHARS = 2000;
/** Overall cap on injected documentation characters. */
const CONTEXT_BUDGET = 10_000;
/** Chars of lead-in kept before the matched region, for heading/sentence context. */
const EXCERPT_LEAD = 160;

/**
 * Common words dropped from the retrieval query before locating the relevant
 * excerpt region, so short filler ("how does…", "what is…") doesn't drag the
 * window toward incidental matches instead of the meaningful terms.
 */
const STOPWORDS = new Set([
  "about",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "use",
  "used",
  "using",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

/** Distinct, meaningful lowercase terms from a query (drops stopwords). */
const queryTerms = (query: string): string[] =>
  [...new Set(query.toLowerCase().match(/[a-z0-9]+/gu))].filter(
    (term) => term.length >= 2 && !STOPWORDS.has(term)
  );

/**
 * The grounding preamble. The model is told to answer strictly from the injected
 * excerpts and to cite the pages it used as Markdown links (each excerpt is
 * headed by `## Title (/route)`), so citations render as real links in the panel.
 */
const BASE_INSTRUCTION =
  "You are a helpful documentation assistant for this project. Answer the user's question using ONLY the documentation excerpts below. Each excerpt is headed by its page as `## Page Title (/route)`. If the answer is not covered by the excerpts, say you don't know and suggest where in the docs to look — do not invent details. Always cite the pages you drew from, and write every citation as a Markdown link to that page using its route, e.g. [Page Title](/route).";

/** Normalize a page path to a document `route` (`/`, `/a/b`, no trailing slash). */
const normalizeRoute = (input: string): string => {
  const noTrailing = input.trim().replace(/\/+$/u, "");
  const withSlash = noTrailing.startsWith("/") ? noTrailing : `/${noTrailing}`;
  return withSlash === "" ? "/" : withSlash;
};

/** The most recent non-empty user message, used as the retrieval query. */
const lastUserMessage = (messages: AskMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && message.content?.trim()) {
      return message.content.trim();
    }
  }
  return "";
};

/**
 * Excerpt the region of `content` most relevant to `query`, not just its head.
 *
 * Pages are indexed whole (one document each), so a naive head slice of a long
 * page returns its intro and misses sections below the fold — the exact failure
 * where "How does Ask AI work?" retrieves the right page but only sees its
 * opening paragraph. This centers the window on the densest cluster of query
 * terms so the injected text is the part that actually answers the question.
 */
const relevantExcerpt = (
  content: string,
  query: string,
  max: number
): string => {
  const trimmed = content.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const withEllipsis = (start: number): string => {
    const slice = trimmed.slice(start, start + max).trim();
    const prefix = start > 0 ? "…" : "";
    const suffix = start + max < trimmed.length ? "…" : "";
    return `${prefix}${slice}${suffix}`;
  };

  const lower = trimmed.toLowerCase();
  const positions: number[] = [];
  for (const term of queryTerms(query)) {
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  // No query terms hit this doc — nothing to center on, so keep the head.
  if (positions.length === 0) {
    return withEllipsis(0);
  }

  // Pick the term hit whose following `max`-char window covers the most hits.
  // `positions` is non-empty here, so the first window (count ≥ 1) always wins
  // over the initial 0 and assigns a real offset to `best`.
  positions.sort((a, b) => a - b);
  let best = 0;
  let bestCount = 0;
  for (const start of positions) {
    const end = start + max;
    let count = 0;
    for (const pos of positions) {
      if (pos >= end) {
        break;
      }
      if (pos >= start) {
        count += 1;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = start;
    }
  }
  return withEllipsis(Math.max(0, best - EXCERPT_LEAD));
};

/**
 * Build the request-time grounding function for the Ask AI endpoint.
 *
 * Lexical retrieval over Orama (the same index/ranking the search dialog and MCP
 * server use). The index is built once and memoized across requests. Returns a
 * grounded system prompt — the retrieved excerpts plus the page the user is
 * viewing — or `undefined` when there is nothing to ground on, so the endpoint
 * can fall back to its plain prompt.
 */
export const createAskContext = (
  data: AskData
): ((
  messages: AskMessage[],
  page?: AskPage
) => Promise<string | undefined>) => {
  let dbPromise: Promise<Awaited<ReturnType<typeof buildOramaIndex>>> | null =
    null;
  const index = () => {
    dbPromise ??= buildOramaIndex(data.documents);
    return dbPromise;
  };
  const byRoute = new Map(data.documents.map((doc) => [doc.route, doc]));

  return async (messages, page) => {
    const list = Array.isArray(messages) ? messages : [];
    const query = lastUserMessage(list);
    if (!query) {
      return;
    }

    // The current page anchors retrieval to its locale and is injected first.
    const current = page?.path
      ? byRoute.get(normalizeRoute(page.path))
      : undefined;
    const db = await index();
    const hits = await queryOramaIndex(
      db,
      query,
      MAX_RESULTS,
      current?.locale || undefined
    );

    const seen = new Set<string>();
    const sections: string[] = [];
    let budget = CONTEXT_BUDGET;
    const push = (doc: OramaDoc, label: string) => {
      if (seen.has(doc.route) || budget <= 0) {
        return;
      }
      seen.add(doc.route);
      const body = relevantExcerpt(
        doc.content,
        query,
        Math.min(EXCERPT_CHARS, budget)
      );
      budget -= body.length;
      sections.push(`## ${doc.title} (${doc.route})${label}\n${body}`);
    };

    if (current) {
      push(current, " — the page the user is currently viewing");
    }
    for (const hit of hits) {
      push(hit, "");
    }

    if (sections.length === 0) {
      return;
    }
    return `${BASE_INSTRUCTION}\n\n<docs>\n${sections.join("\n\n")}\n</docs>`;
  };
};
