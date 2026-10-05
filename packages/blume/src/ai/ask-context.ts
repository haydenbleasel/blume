import { normalizeRoute } from "../core/base-path.ts";
import { nextFenceState } from "../core/code-fences.ts";
import type { FenceState } from "../core/code-fences.ts";
import { buildOramaIndex, queryOramaIndex } from "../search/orama-index.ts";
import type { OramaDoc } from "../search/orama-index.ts";

/** A chat message as posted by the assistant island (`{ role, content }`). */
export interface AskMessage {
  content: string;
  role: string;
}

/** The current-page hint the island forwards so the endpoint can prioritize it. */
export interface AskPage {
  path?: string;
}

/**
 * The self-contained snapshot the assistant's grounded endpoint imports. Bundles the
 * search documents so retrieval works regardless of the configured search
 * provider and needs no filesystem access at request time. Serialized to
 * `generated/ask-data.json` and built by {@link buildAskData}.
 */
export interface AskData {
  /**
   * The site's `i18n.defaultLocale`, when i18n is configured. Selects a
   * word-segmenting Orama tokenizer for every non-Latin script, so retrieval
   * can match CJK, Cyrillic, Greek, Hebrew, or Devanagari content.
   */
  defaultLocale?: string;
  documents: OramaDoc[];
  site: string | null;
  /**
   * Present on a versioned site, whose documents then carry their `version`
   * (`""` for the current docs): retrieval keeps to the version the reader
   * is viewing — the current docs unless they're on an archived page — as
   * the search dialog does.
   */
  versioned?: boolean;
}

/** Documents retrieved per question and injected into the system prompt. */
const MAX_RESULTS = 6;
/** Characters kept per injected excerpt. */
const EXCERPT_CHARS = 2000;
/** Overall cap on injected documentation characters. */
const CONTEXT_BUDGET = 10_000;
/**
 * Smallest excerpt worth injecting. A long page pushed under a tiny residual
 * budget would get a full `## Title (/route)` heading over a fragment of a few
 * dozen characters — a section the model is invited to cite but that grounds
 * nothing. Short pages that fit whole are still injected below this floor.
 */
const MIN_EXCERPT_CHARS = 200;

/**
 * How much retrieved documentation a question carries (the `ai.assistant.retrieval`
 * config). Every field falls back to the built-in default, so a partial object
 * only changes what it names. Injected characters dominate time-to-first-token
 * on a self-hosted backend, and the three knobs aren't interchangeable: the
 * budget caps the total, `excerptChars` decides how deep into one long page the
 * excerpt reaches, and `maxResults` decides how many pages retrieval adds (the
 * page the reader is viewing is injected on top of them).
 */
export interface AskRetrievalOptions {
  /** Overall cap on injected documentation characters. Defaults to `10000`. */
  contextBudget?: number;
  /** Characters kept per injected excerpt. Defaults to `2000`. */
  excerptChars?: number;
  /**
   * Documents retrieved per question. Defaults to `6`. The current page is
   * injected in addition when it isn't among the hits.
   */
  maxResults?: number;
}
/** Chars of lead-in kept before the matched region, for heading/sentence context. */
const EXCERPT_LEAD = 160;

/**
 * Remove English filler from retrieval and excerpt queries. Keep content verbs
 * such as "sign", "file" and "close", which can name documentation topics.
 */
const STOPWORDS = new Set([
  "a",
  "about",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "both",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "done",
  "each",
  "every",
  "for",
  "from",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "like",
  "look",
  "may",
  "me",
  "might",
  "mine",
  "must",
  "my",
  "nor",
  "of",
  "on",
  "or",
  "other",
  "our",
  "ours",
  "shall",
  "she",
  "should",
  "so",
  "some",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "us",
  "use",
  "used",
  "using",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
]);

/** A run of letters, combining marks and digits inside a word-like segment. */
const TERM = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * Word-shaped pieces of a query, NFC-normalized and lowercased. Languages
 * written without spaces (the CJK/Thai sites the Orama tokenizer goes out of
 * its way to support) have no delimiter for a regex to split on, so the query
 * is cut with `Intl.Segmenter` where available — otherwise every excerpt
 * window silently degrades to the head of the page. The regex fallback covers
 * runtimes without the segmenter and still handles spaced scripts correctly.
 */
const hasSegmenter = (
  segmenter: typeof Intl.Segmenter | undefined
): segmenter is typeof Intl.Segmenter => typeof segmenter === "function";

const segmentQuery = (query: string): string[] => {
  const lowered = query.normalize("NFC").toLowerCase();
  if (!hasSegmenter(Intl.Segmenter)) {
    return lowered.match(TERM) ?? [];
  }
  const pieces: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  for (const segment of segmenter.segment(lowered)) {
    if (segment.isWordLike) {
      pieces.push(segment.segment);
    }
  }
  return pieces;
};

/** Lowercase word tokens of `text`, cut at the same boundaries as a query. */
const tokenize = (text: string): string[] =>
  segmentQuery(text).flatMap((piece) => piece.match(TERM) ?? []);

/** Distinct, meaningful lowercase terms from a query (drops stopwords). */
const queryTerms = (query: string): string[] =>
  [...new Set(tokenize(query))].filter(
    (term) => term.length >= 2 && !STOPWORDS.has(term)
  );

/**
 * The grounding preamble. The model is told to answer strictly from the injected
 * excerpts and to cite the pages it used as Markdown links (each excerpt is
 * headed by `## Title (/route)`), so citations render as real links in the panel.
 */
const BASE_INSTRUCTION =
  "You are a helpful documentation assistant for this project. Answer the user's question using ONLY the documentation excerpts below. Each excerpt is headed by its page as `## Page Title (/route)`. If the answer is not covered by the excerpts, say you don't know and suggest where in the docs to look — do not invent details. Always cite the pages you drew from, and write every citation as a Markdown link to that page using its route, e.g. [Page Title](/route).";

/**
 * Appended when the endpoint gives the model the docs tools (see
 * `ask-tools.ts`): the excerpts are a head start, not the whole of the docs.
 */
const TOOL_INSTRUCTION =
  "You can also search the documentation yourself. When the excerpts don't fully answer the question, call search_docs with a focused query to find other pages, and read_page to read a page in full (one an excerpt cuts off, say) before you answer. Treat tool results exactly like the excerpts: answer only from them, and cite the pages you drew from the same way.";

/** Said instead of the excerpts when retrieval found none but tools can look. */
const NO_EXCERPTS_WITH_TOOLS =
  "No documentation excerpts matched this question up front. Use search_docs to look before you answer.";

/** The non-empty user turns, oldest first. Assistant turns never seed retrieval. */
const userTurns = (messages: AskMessage[]): string[] =>
  messages
    .filter((message) => message?.role === "user" && message.content?.trim())
    .map((message) => message.content.trim());

/** Meaningful terms below which a follow-up cannot stand as a query on its own. */
const MIN_QUERY_TERMS = 3;

const FOLLOW_UP_OPENERS = new Set(["also", "and", "but", "then"]);
const ANAPHORA = new Set([
  "it",
  "its",
  "that",
  "them",
  "these",
  "they",
  "this",
  "those",
]);

const isFollowUp = (message: string): boolean => {
  const words = segmentQuery(message);
  const [first] = words;
  return (
    (first !== undefined && FOLLOW_UP_OPENERS.has(first)) ||
    words.some((word) => ANAPHORA.has(word))
  );
};

/**
 * The texts that retrieve for the latest question, in rank order.
 *
 * The question itself always leads, verbatim: Orama's own tokenizer and BM25
 * weighting see the whole sentence (version numbers, single-character CJK
 * words, `--flags`, and the bigrams a ja/zh index depends on all survive), and
 * a short question that names its subject ("Does it support i18n?") is never
 * outvoted by whatever the reader asked before. Only when it reads like a
 * follow-up — opener-led, pronoun-bearing, or nothing but filler ("Why?") —
 * and is too short to stand alone does the nearest earlier user turn with
 * content terms join as a second query, ranked behind the first so the earlier
 * subject stays in view without displacing the current one. Assistant turns
 * are excluded, so an incorrect answer cannot reinforce its own retrieval.
 */
const retrievalQueries = (turns: string[]): string[] => {
  const [latest = "", ...earlier] = turns.toReversed();
  const terms = queryTerms(latest);
  if (terms.length >= MIN_QUERY_TERMS) {
    return [latest];
  }
  if (terms.length > 0 && !isFollowUp(latest)) {
    return [latest];
  }
  const context = earlier.find((turn) => queryTerms(turn).length > 0);
  if (context === undefined) {
    return [latest];
  }
  return terms.length === 0 ? [context] : [latest, context];
};

/**
 * Merge ranked result lists round-robin — the first list's top hit, then the
 * second's, and so on — dropping duplicate routes and stopping at `limit`.
 */
const interleave = (lists: OramaDoc[][], limit: number): OramaDoc[] => {
  const merged: OramaDoc[] = [];
  const seen = new Set<string>();
  const depth = Math.max(...lists.map((list) => list.length));
  for (let rank = 0; rank < depth; rank += 1) {
    for (const list of lists) {
      const doc = list[rank];
      if (doc && !seen.has(doc.route)) {
        seen.add(doc.route);
        merged.push(doc);
      }
      if (merged.length >= limit) {
        return merged;
      }
    }
  }
  return merged;
};

/**
 * Excerpt the region of `content` most relevant to `query`, not just its head.
 *
 * Pages are indexed whole (one document each), so a naive head slice of a long
 * page returns its intro and misses sections below the fold — the exact failure
 * where "How does the assistant work?" retrieves the right page but only sees its
 * opening paragraph. This centers the window on the densest cluster of query
 * terms so the injected text is the part that actually answers the question.
 * Exported for testing; {@link createAskContext} is the runtime entry point.
 */
export const relevantExcerpt = (
  content: string,
  query: string,
  max: number
): string => {
  // NFC to match the normalized query terms; positions are computed on (and
  // sliced from) this same string, so offsets stay aligned.
  const trimmed = content.normalize("NFC").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const withEllipsis = (start: number): string => {
    const slice = trimmed.slice(start, start + max).trim();
    const prefix = start > 0 ? "…" : "";
    const suffix = start + max < trimmed.length ? "…" : "";
    return `${prefix}${slice}${suffix}`;
  };

  // Case-insensitive matching via regex rather than `indexOf` on a lowercased
  // copy: length-changing case mappings (Turkish İ → "i" + U+0307) would shift
  // every index in the copy, sliding the excerpt window off the match. Terms
  // come from TERM (letters, marks and digits only), so no regex escaping.
  const positions: number[] = [];
  for (const term of queryTerms(query)) {
    for (const match of trimmed.matchAll(new RegExp(term, "giu"))) {
      positions.push(match.index);
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
  // Cap the lead-in at half the window: under a tight remaining budget `max`
  // can be smaller than EXCERPT_LEAD, and an uncapped `best - EXCERPT_LEAD`
  // start would end the slice before the very match it centered on.
  const lead = Math.min(EXCERPT_LEAD, Math.floor(max / 2));
  return withEllipsis(Math.max(0, best - lead));
};

/** A Markdown heading at level 2 or deeper — where a page divides itself. */
const SECTION_HEADING = /^ {0,3}#{2,6}[\t ]+.+$/u;
/** Any ATX heading, including the `#` title a lead-in may open with. */
const ANY_HEADING = /^ {0,3}#{1,6}[\t ]+.+$/u;

/** Offsets of the section headings in `text`, skipping fenced code. */
const sectionStarts = (text: string): number[] => {
  const starts: number[] = [];
  let fence: FenceState = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const next = nextFenceState(line, fence);
    if (fence === null && next === null && SECTION_HEADING.test(line)) {
      starts.push(offset);
    }
    fence = next;
    offset += line.length + 1;
  }
  return starts;
};

interface PageSection {
  /** Word tokens of the section's heading line, or none when it has no heading. */
  headingWords: string[];
  /** Position in the page, for source-order output and omission markers. */
  index: number;
  text: string;
  /** The section's word tokens, cut once so scoring is a prefix test. */
  words: string[];
}

/** A page split into sections once, so per-request scoring never re-tokenizes. */
export interface ParsedPage {
  sections: PageSection[];
  /** NFC-normalized, LF-only, trimmed page text; excerpts slice from it. */
  text: string;
}

/**
 * Split a page at its `##`+ headings (outside code fences). The text above the
 * first heading is the page's own lead-in and is a section like any other.
 * Line endings are folded to LF first so a CRLF checkout splits and matches the
 * same way as an LF one. Exported for testing; {@link createAskContext}
 * parses each page once and caches it across requests.
 */
export const parsePage = (content: string): ParsedPage => {
  const text = content.normalize("NFC").replaceAll("\r\n", "\n").trim();
  const headings = sectionStarts(text);
  if (headings.length === 0) {
    return { sections: [], text };
  }
  const starts = headings[0] === 0 ? headings : [0, ...headings];
  const sections = starts.map((start, index) => {
    const section = text.slice(start, starts[index + 1]).trim();
    const [firstLine = ""] = section.split("\n", 1);
    const headingWords = ANY_HEADING.test(firstLine) ? tokenize(firstLine) : [];
    return { headingWords, index, text: section, words: tokenize(section) };
  });
  return { sections, text };
};

interface ScoredSection extends PageSection {
  /** How many distinct query terms the section mentions. */
  coverage: number;
  /** Term hits per word, so a long section can't win on bulk alone. */
  density: number;
  /** How many distinct query terms the section's heading names. */
  titled: number;
}

interface TermMatch {
  /** Every word that starts with a term counts once. */
  hits: number;
  /** Distinct terms some word starts with. */
  matched: number;
}

/** How `words` match `terms` by prefix. */
const matchTerms = (words: string[], terms: string[]): TermMatch => {
  const matched = new Set<string>();
  let hits = 0;
  for (const word of words) {
    for (const term of terms) {
      if (word.startsWith(term)) {
        matched.add(term);
        hits += 1;
      }
    }
  }
  return { hits, matched: matched.size };
};

/**
 * Score a section by the query terms it covers, then by whether its heading
 * names them, then by how densely it hits them. Raw hit counts would hand the
 * excerpt to the longest section — a reference table that says "matter" once
 * per row outscores the short "Closing a matter" section that actually answers
 * "close matter" — and among sections covering the same terms, the one titled
 * with a term is the one about it.
 */
const scoreSection = (section: PageSection, terms: string[]): ScoredSection => {
  const body = matchTerms(section.words, terms);
  return {
    ...section,
    coverage: body.matched,
    density: body.hits / Math.max(1, section.words.length),
    titled: matchTerms(section.headingWords, terms).matched,
  };
};

const excerptLongSection = (
  section: string,
  query: string,
  max: number
): string => {
  const [heading = "", ...rest] = section.split("\n");
  const body = rest.join("\n").trim();
  if (!SECTION_HEADING.test(heading) || body === "") {
    return relevantExcerpt(section, query, max);
  }
  // The heading names what the model is reading, so keep it whenever it
  // leaves at least half the budget for the body beneath it.
  const room = max - heading.length - 1;
  if (room < Math.floor(max / 2)) {
    return relevantExcerpt(section, query, max);
  }
  return `${heading}\n${relevantExcerpt(body, query, room)}`;
};

/**
 * Preserve headings and lists by selecting whole sections that cover the query
 * best, then emitting them in document order. An oversized best section falls
 * back to a relevant window under its heading; ellipses mark omitted content.
 */
const excerptPage = (page: ParsedPage, query: string, max: number): string => {
  if (page.text.length <= max) {
    return page.text;
  }
  const terms = queryTerms(query);
  if (terms.length === 0 || page.sections.length === 0) {
    return relevantExcerpt(page.text, query, max);
  }

  const ranked = page.sections
    .map((section) => scoreSection(section, terms))
    .filter((section) => section.coverage > 0)
    .toSorted(
      (a, b) =>
        b.coverage - a.coverage ||
        b.titled - a.titled ||
        b.density - a.density ||
        a.index - b.index
    );
  const [bestSection] = ranked;
  if (!bestSection) {
    return relevantExcerpt(page.text, query, max);
  }
  if (bestSection.text.length > max) {
    // The window lands wherever the terms cluster, which is rarely the first
    // line — so the heading that names what the model is reading would be the
    // first thing cut. Hold it back and window only the body beneath it.
    return excerptLongSection(bestSection.text, query, max);
  }

  const last = page.sections.length - 1;
  const render = (selected: ScoredSection[]): string => {
    const ordered = selected.toSorted((a, b) => a.index - b.index);
    const parts: string[] = [];
    let previous = -1;
    for (const section of ordered) {
      if (previous !== -1 && section.index !== previous + 1) {
        parts.push("…");
      }
      parts.push(section.text);
      previous = section.index;
    }
    const [first] = ordered;
    if (first && first.index > 0) {
      parts.unshift("…");
    }
    if (previous < last) {
      parts.push("…");
    }
    return parts.join("\n\n");
  };

  // Like `relevantExcerpt`, the result may run two characters over `max` for
  // the ellipses that mark omitted content.
  const chosen: ScoredSection[] = [];
  for (const section of ranked) {
    const candidate = [...chosen, section];
    if (render(candidate).length <= max + 2) {
      chosen.push(section);
    }
  }
  if (chosen.length === 0) {
    return excerptLongSection(bestSection.text, query, max);
  }
  return render(chosen);
};

/** {@link excerptPage} over a page parsed on the spot. Exported for testing. */
export const sectionExcerpt = (
  content: string,
  query: string,
  max: number
): string => excerptPage(parsePage(content), query, max);

// One Orama index per snapshot, shared by the grounding function and the
// docs tools so a cold endpoint builds it once.
const indexes = new WeakMap<AskData, ReturnType<typeof buildOramaIndex>>();

/** The search index over an assistant snapshot, built on first use. */
export const askIndex = (data: AskData): ReturnType<typeof buildOramaIndex> => {
  let index = indexes.get(data);
  if (!index) {
    index = buildOramaIndex(data.documents, data.defaultLocale);
    indexes.set(data, index);
  }
  return index;
};

/** The page the reader is on, and the search filters it implies. */
export interface ReaderScope {
  current: OramaDoc | undefined;
  filters: { locale: string | undefined; version: string | undefined };
}

// The snapshot's locale codes, keyed lowercase, built once per snapshot.
const localeCodes = new WeakMap<AskData, Map<string, string>>();

/**
 * The locale a path's first segment names (`/ja` or `/ja/pricing` → `ja`),
 * when it's one the snapshot's documents carry: a page outside the docs,
 * like a localized landing page, still says which language it's in.
 */
const pathLocale = (data: AskData, path: string): string | undefined => {
  let codes = localeCodes.get(data);
  if (!codes) {
    codes = new Map<string, string>();
    for (const { locale } of data.documents) {
      if (locale) {
        codes.set(locale.toLowerCase(), locale);
      }
    }
    localeCodes.set(data, codes);
  }
  const [, first = ""] = normalizeRoute(path).split("/");
  return first ? codes.get(first.toLowerCase()) : undefined;
};

/**
 * Where the reader is: their page, when it's in the snapshot, and the locale
 * and docs version retrieval keeps to. A page the snapshot doesn't have (the
 * homepage, a custom page, or none at all from a cross-origin caller) keeps
 * to the locale its path's first segment names, or the default locale, so
 * translations of every page don't crowd each other out. Without a page, a
 * versioned site grounds in the current docs rather than every archived copy
 * of each page.
 */
export const readerScope = (
  data: AskData,
  byRoute: ReadonlyMap<string, OramaDoc>,
  page?: AskPage
): ReaderScope => {
  const current = page?.path
    ? byRoute.get(normalizeRoute(page.path))
    : undefined;
  const locale = current
    ? current.locale
    : (page?.path && pathLocale(data, page.path)) || data.defaultLocale;
  return {
    current,
    filters: {
      locale: locale || undefined,
      version: data.versioned ? (current?.version ?? "") : undefined,
    },
  };
};

/**
 * Build the request-time grounding function for the assistant endpoint.
 *
 * Lexical retrieval over Orama (the same index/ranking the search dialog and MCP
 * server use). The index is built once and memoized across requests. Returns a
 * grounded system prompt — the retrieved excerpts plus the page the user is
 * viewing — or `undefined` when there is nothing to ground on, so the endpoint
 * can fall back to its plain prompt.
 *
 * `options.instructions` (the `ai.assistant.instructions` config) is appended after
 * the base instruction rather than replacing it: the base carries the
 * functional contract (answer only from the excerpts, cite pages as Markdown
 * links) that the panel's citation rendering depends on.
 *
 * `options.retrieval` (the `ai.assistant.retrieval` config) sizes how much
 * documentation each question carries; omitted fields keep today's defaults.
 *
 * `options.tools` says the endpoint also hands the model the docs tools: the
 * prompt then says so, and a question retrieval found nothing for still gets
 * a grounded prompt, since the model can go and search.
 */
export const createAskContext = (
  data: AskData,
  options?: {
    instructions?: string;
    retrieval?: AskRetrievalOptions;
    tools?: boolean;
  }
): ((
  messages: AskMessage[],
  page?: AskPage
) => Promise<string | undefined>) => {
  const byRoute = new Map(data.documents.map((doc) => [doc.route, doc]));
  // Section splitting and tokenizing are per page, not per question, so each
  // page is parsed on first use and reused for the life of the endpoint.
  const parsed = new Map<string, ParsedPage>();
  const pageOf = (doc: OramaDoc): ParsedPage => {
    let page = parsed.get(doc.route);
    if (page === undefined) {
      page = parsePage(doc.content);
      parsed.set(doc.route, page);
    }
    return page;
  };
  const base = options?.tools
    ? `${BASE_INSTRUCTION} ${TOOL_INSTRUCTION}`
    : BASE_INSTRUCTION;
  const instruction = options?.instructions
    ? `${base}\n\n${options.instructions}`
    : base;
  const maxResults = options?.retrieval?.maxResults ?? MAX_RESULTS;
  const excerptChars = options?.retrieval?.excerptChars ?? EXCERPT_CHARS;
  const contextBudget = options?.retrieval?.contextBudget ?? CONTEXT_BUDGET;

  return async (messages, page) => {
    const list = Array.isArray(messages) ? messages : [];
    const turns = userTurns(list);
    if (turns.length === 0) {
      return;
    }
    const queries = retrievalQueries(turns);
    // The leading query is what the reader is asking about now; it also decides
    // which part of each page is quoted.
    const [query = ""] = queries;

    // The current page anchors retrieval to its locale and docs version, and
    // is injected first.
    const { current, filters } = readerScope(data, byRoute, page);
    const db = await askIndex(data);
    const hits = interleave(
      await Promise.all(
        queries.map((text) => queryOramaIndex(db, text, maxResults, filters))
      ),
      maxResults
    );

    const seen = new Set<string>();
    const sections: string[] = [];
    let budget = contextBudget;
    const push = (doc: OramaDoc, label: string) => {
      if (seen.has(doc.route) || budget <= 0) {
        return;
      }
      const parsedPage = pageOf(doc);
      // Skip a page that would be cut to a junk fragment: its excerpt is only
      // useful when it either fits whole or gets at least the minimum window.
      if (budget < MIN_EXCERPT_CHARS && parsedPage.text.length > budget) {
        return;
      }
      seen.add(doc.route);
      const body = excerptPage(
        parsedPage,
        query,
        Math.min(excerptChars, budget)
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
      return options?.tools
        ? `${instruction}\n\n${NO_EXCERPTS_WITH_TOOLS}`
        : undefined;
    }
    return `${instruction}\n\n<docs>\n${sections.join("\n\n")}\n</docs>`;
  };
};
