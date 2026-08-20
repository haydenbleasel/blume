import { escape } from "html-escaper";

/** A single result rendered in the search dialog. */
export interface SearchHit {
  url: string;
  /** Title, possibly containing `<mark>` highlight markup. */
  title: string;
  /** Excerpt, possibly containing `<mark>` highlight markup. */
  excerpt: string;
  /** Ancestor section labels for the breadcrumb, e.g. `["Guides", "Auth"]`. */
  breadcrumb?: string[];
  /** Top-level section label, used by the filter pills. */
  section?: string;
  /** Plain-text page content, used to render the preview pane. */
  content?: string;
  /**
   * Docs version the hit belongs to (`""` = current). Local indexes and the
   * hosted Algolia/Typesense adapters set it; other providers leave it unset.
   */
  version?: string;
}

/** A category pill with its result count. */
export interface SectionCount {
  label: string;
  count: number;
}

/** What every provider returns: ranked hits plus section facet counts. */
export interface SearchResult {
  hits: SearchHit[];
  sections: SectionCount[];
}

/** A configured query function — the common contract every provider returns. */
export type SearchFn = (
  query: string,
  options?: {
    section?: string;
    locale?: string;
    /** Docs version to scope to (`""` = current); omitted disables it. */
    version?: string;
  }
) => Promise<SearchResult>;

/** A document in the client-loaded `blume-search.json` index. */
export interface IndexedDocument {
  route: string;
  title: string;
  description: string;
  content: string;
  breadcrumb?: string[];
  section?: string;
  locale?: string;
  version?: string;
}

/** Max results surfaced in the dialog. */
export const SEARCH_LIMIT = 12;

/**
 * How many ranked matches the static providers pull before filtering, so the
 * section pills can count across more than just the visible page.
 */
export const RESULT_POOL = 48;

const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;
const WORD_BREAK = /\s+/u;

/** Split a query into escaped, non-empty search tokens. */
const queryTokens = (query: string): string[] =>
  query
    .trim()
    .split(WORD_BREAK)
    .filter(Boolean)
    .map((token) => token.replaceAll(REGEXP_SPECIAL, String.raw`\$&`));

/**
 * Wrap query matches in `<mark>`, HTML-escaping the source text. Matching runs
 * on the *raw* text and escaping on each segment — matching after escaping
 * would let a query like "amp" or "lt" mark the inside of an entity produced
 * from the source (`&amp;` in "a & b"), corrupting the rendered excerpt.
 */
export const highlight = (text: string, query: string): string => {
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return escape(text);
  }
  const pattern = new RegExp(`(${tokens.join("|")})`, "giu");
  return text
    .split(pattern)
    .map((segment, index) =>
      index % 2 === 1 ? `<mark>${escape(segment)}</mark>` : escape(segment)
    )
    .join("");
};

// Either a tag-shaped run — an opening `<` with a letter or `/` after it,
// through the closing `>` (or end of string for an unterminated tag) — or a
// lone `<`. A run can't span a later `<` (`[^<>]`), so between the two
// alternatives every `<` in the input lands inside a captured run.
const ANGLE_RUN = /(?<run><\/?[a-z][^<>]*>?|<)/iu;
const BARE_MARK = /^<\/?mark>$/iu;

/**
 * Reduce provider-supplied excerpt markup to the `<mark>` highlighting the
 * dialog expects. Remote excerpts (Pagefind's index, hosted engines) are
 * rendered via `innerHTML`, so the output alphabet is pinned: bare
 * `<mark>`/`</mark>` tags (attributes make even a mark untrusted), text, and
 * entities. Tag-shaped runs are dropped; every other `<` is escaped, which
 * renders identically but can't be parsed as markup (`<!--` would otherwise
 * open a comment in `innerHTML` and swallow the rest of the excerpt). Split on
 * runs covering every `<` rather than deleting tags in place: a deletion can
 * splice the text around it into a fresh tag (`<<b>script>` → `<script>`),
 * while here no `<` survives outside a run, so the only ones emitted are the
 * bare mark tags. String-level on purpose: this also runs under DOM-less
 * tests, where DOMPurify/DOMParser don't exist.
 */
export const sanitizeExcerpt = (html: string): string =>
  html
    .split(ANGLE_RUN)
    .map((part, index) => {
      if (index % 2 === 0 || BARE_MARK.test(part)) {
        return part;
      }
      return part === "<" ? "&lt;" : "";
    })
    .join("");

/** First index in `text` where any query token matches (case-insensitive). */
const matchIndex = (text: string, query: string): number => {
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return -1;
  }
  return text.search(new RegExp(tokens.join("|"), "iu"));
};

/**
 * A plain-text window around the first query match, fenced with ellipses.
 * Falls back to the head of the text when nothing matches.
 */
export const matchSnippet = (
  text: string,
  query: string,
  radius: number
): string => {
  const index = matchIndex(text, query);
  if (index < 0) {
    const head = text.slice(0, radius).trim();
    return head.length < text.length ? `${head}…` : head;
  }
  const start = Math.max(0, index - Math.floor(radius / 3));
  const end = Math.min(text.length, start + radius);
  const slice = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
};

/** Build the excerpt shown under a result title. */
export const excerptFor = (
  description: string,
  content: string,
  query?: string
): string => {
  if (query && matchIndex(content, query) >= 0) {
    return matchSnippet(content, query, 160);
  }
  if (description) {
    return description;
  }
  const head = content.slice(0, 140);
  return head.length < content.length ? `${head}…` : head;
};

/** Tally how many matches fall into each section, in first-seen order. */
const countSections = (docs: IndexedDocument[]): SectionCount[] => {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    if (doc.section) {
      counts.set(doc.section, (counts.get(doc.section) ?? 0) + 1);
    }
  }
  return [...counts].map(([label, count]) => ({ count, label }));
};

/**
 * Shared shaping for the static providers (Orama, FlexSearch): count sections
 * across the full match pool, apply the active section filter, then map the
 * visible slice to highlighted hits.
 */
export const buildResult = (
  docs: IndexedDocument[],
  query: string,
  section?: string
): SearchResult => {
  const sections = countSections(docs);
  const filtered = section
    ? docs.filter((doc) => doc.section === section)
    : docs;
  const hits = filtered.slice(0, SEARCH_LIMIT).map((doc) => ({
    breadcrumb: doc.breadcrumb ?? [],
    content: doc.content,
    excerpt: highlight(excerptFor(doc.description, doc.content, query), query),
    section: doc.section ?? "",
    title: highlight(doc.title, query),
    url: doc.route,
    version: doc.version,
  }));
  return { hits, sections };
};
