/** A single result rendered in the search dialog. */
export interface SearchHit {
  url: string;
  title: string;
  excerpt: string;
}

/** A configured query function — the common contract every provider returns. */
export type SearchFn = (query: string) => Promise<SearchHit[]>;

/** A document in the client-loaded `blume-search.json` index. */
export interface IndexedDocument {
  route: string;
  title: string;
  description: string;
  content: string;
}

/** Max results surfaced in the dialog. */
export const SEARCH_LIMIT = 8;

/** Build the excerpt shown under a result title. */
export const excerptFor = (description: string, content: string): string =>
  description || `${content.slice(0, 140)}…`;
