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
  options?: { section?: string; locale?: string }
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
}

/** Max results surfaced in the dialog. */
export const SEARCH_LIMIT = 12;

/**
 * How many ranked matches the static providers pull before filtering, so the
 * section pills can count across more than just the visible page.
 */
export const RESULT_POOL = 48;

const HTML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};
const HTML_CHARS = /["&'<>]/gu;
const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;
const WORD_BREAK = /\s+/u;

/** Escape HTML so untrusted text renders literally inside the dialog. */
export const escapeHtml = (text: string): string =>
  text.replaceAll(HTML_CHARS, (char) => HTML_ESCAPES[char] ?? char);

/** Split a query into escaped, non-empty search tokens. */
const queryTokens = (query: string): string[] =>
  query
    .trim()
    .split(WORD_BREAK)
    .filter(Boolean)
    .map((token) => token.replaceAll(REGEXP_SPECIAL, String.raw`\$&`));

/** Wrap query matches in `<mark>`, after HTML-escaping the source text. */
export const highlight = (text: string, query: string): string => {
  const escaped = escapeHtml(text);
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return escaped;
  }
  const pattern = new RegExp(`(?<match>${tokens.join("|")})`, "giu");
  return escaped.replaceAll(pattern, "<mark>$<match></mark>");
};

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
  return description || `${content.slice(0, 140)}…`;
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
  }));
  return { hits, sections };
};
