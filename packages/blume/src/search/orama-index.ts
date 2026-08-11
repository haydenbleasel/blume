import { create, insertMultiple, search } from "@orama/orama";
import type { AnyOrama, Tokenizer } from "@orama/orama";

/**
 * The minimal document shape both the client-side search dialog and the
 * server-side MCP `search_docs` tool index. Mirrors the `blume-search.json`
 * entries built by `buildSearchDocuments`.
 */
export interface OramaDoc {
  content: string;
  description: string;
  route: string;
  title: string;
  /** Locale code; indexed as an enum so queries can filter to one language. */
  locale?: string;
  /** Resolved page `type`; indexed as an enum so queries can filter by type. */
  contentType?: string;
  /** Declared facet values (`content.types.<type>.facets`), key → value. */
  facets?: Record<string, string>;
  /** Carried through for the search dialog's breadcrumb + filter pills. Stored
   * but not indexed, so they ride along on the returned document untouched. */
  breadcrumb?: string[];
  section?: string;
}

const SCHEMA = {
  content: "string",
  // Enums (not full-text "string") so `where` does an exact-match filter.
  contentType: "enum",
  description: "string",
  // Facets, flattened to `key:value` terms — enum[] so one static schema
  // serves every project's facet keys, with `containsAll` matching a filter
  // set. Derived from `facets` at insert time.
  facetTerms: "enum[]",
  locale: "enum",
  route: "string",
  title: "string",
} as const;

/** Flatten a facet map to the `key:value` terms the `facetTerms` enum holds. */
const toFacetTerms = (facets: Record<string, string>): string[] =>
  Object.entries(facets).map(([key, value]) => `${key}:${value}`);

/** Title and description outrank body text, matching the search dialog. */
const BOOST = { description: 2, title: 3 };

/**
 * Scripts written without spaces between words. Orama's default tokenizer
 * splits on a Latin-centric delimiter class, so text in these languages
 * collapses to zero tokens and every query silently returns no hits. Keyed by
 * the primary language subtag of `i18n.defaultLocale`.
 */
const SEGMENTED_LANGUAGES = new Set(["ja", "ko", "th", "zh"]);

/**
 * Languages indexed as character bigrams rather than whole segments, and
 * queried to match accordingly. Japanese and Chinese write compounds in
 * {@link BIGRAM_SCRIPTS} without delimiters; Korean separates words with
 * spaces and Thai has no comparable bigram convention, so both keep the plain
 * segmented tokens even where a page mixes in Han or kana.
 *
 * Dictionary segmentation alone drops the adjacency that makes a compound term
 * distinctive: 資金決済法 becomes 資金 / 決済 / 法, and because Orama scores a
 * bag of words, a page that merely mentions each fragment somewhere outranks
 * the page about the law itself. Bigrams put that adjacency back as index
 * terms, and dropping the whole-segment tokens keeps a fragment as common as
 * 法 from matching on its own.
 */
const BIGRAM_LANGUAGES = new Set(["ja", "zh"]);

/**
 * Segments written entirely in these scripts are the ones re-cut into bigrams,
 * matching the scripts Lucene's CJK analyzer bigrams. Property escapes rather
 * than ranges, so ideographs outside the basic plane are covered as well —
 * 𠮟, the 常用漢字表 form of しかる, is one. The literals that follow belong to
 * no script of their own but appear only inside such words: the iteration
 * marks, the prolonged sound mark, and the halfwidth voiced sound marks.
 */
const BIGRAM_SCRIPTS =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆〇ーﾞﾟ]+$/u;

/**
 * One index term inside a word-like segment. Being word-like does not make a
 * segment all letters: UAX #29 keeps connector punctuation, format characters
 * and mid-number punctuation *within* a word, so `Intl.Segmenter` reports
 * スネーク_ケース and robots.txt as one segment each. A term is a run of
 * letters, combining marks and digits. Marks are spelling, not punctuation —
 * Thai writes vowels and tones as combining marks, so dropping them leaves
 * consonant skeletons that collapse distinct words (เสื้อ, shirt, and เสือ,
 * tiger, differ by one mark). Two separators stay where the surrounding text
 * makes them part of the word: an apostrophe followed by a letter (don't),
 * and a decimal point or thousands separator flanked by digits (1.0.3,
 * 1,000) — split, either would leave one-letter and one-digit fragments that
 * co-occur on unrelated pages.
 */
const TERM =
  /[\p{L}\p{M}\p{N}]+(?:(?:['’](?=\p{L})|(?<=\p{N})[.,](?=\p{N}))[\p{L}\p{M}\p{N}]+)*/gu;

/**
 * Emit every overlapping 2-character window of `run`, or the lone character.
 * Windows are cut by code point: an ideograph outside the basic plane is a
 * surrogate pair, and slicing by code unit would split it into halves that
 * match nothing.
 *
 * Dropping the whole-segment tokens means a single-character query reaches
 * only pages where the character opens a bigram: a run-final 法 sits in 示法,
 * which the query 法 does not prefix-match. Lucene's CJK analyzer shares this
 * property; indexing lone characters alongside the bigrams would reinvite the
 * fragment noise this file exists to remove.
 */
const addBigrams = (run: string, tokens: Set<string>): void => {
  const characters = [...run];
  if (characters.length === 1) {
    tokens.add(run);
    return;
  }
  let previous = "";
  for (const character of characters) {
    if (previous) {
      tokens.add(previous + character);
    }
    previous = character;
  }
};

/**
 * A word-segmenting tokenizer for languages the default splitter can't handle,
 * built on `Intl.Segmenter` (the same engine `@orama/tokenizers` wraps).
 * Input is NFC-normalized and lowercased before segmenting — unlike the
 * upstream tokenizers — so decomposed text (macOS filenames, some CMS
 * pipelines) indexes the same terms a composed query produces, and Latin
 * terms ("GDPR", English pages on a mixed-locale site) still match
 * case-insensitively. Returns `undefined` for languages the default tokenizer
 * already serves, and on runtimes without `Intl.Segmenter`, where the caller
 * falls back to Orama's default.
 *
 * On a {@link BIGRAM_LANGUAGES} index, runs of adjacent
 * {@link BIGRAM_SCRIPTS} segments are joined and re-cut into character
 * bigrams; everything else (Latin, digits, and every segment on a Korean or
 * Thai index) is emitted one {@link TERM} at a time. Separators end a run
 * either way — whether they stand between segments, as 「クーリング・オフ」
 * does, or inside one.
 */
const segmentingTokenizer = (locale?: string): Tokenizer | undefined => {
  const language = locale?.toLowerCase().split(/[-_]/u)[0] ?? "";
  if (!SEGMENTED_LANGUAGES.has(language)) {
    return;
  }
  if (typeof Intl.Segmenter !== "function") {
    return;
  }
  const segmenter = new Intl.Segmenter(language, { granularity: "word" });
  // Keyed off the same set the strict query pass reads, so an index is never
  // built from bigrams that the query side then matches loosely.
  const bigram = BIGRAM_LANGUAGES.has(language);
  return {
    language,
    normalizationCache: new Map(),
    tokenize: (raw: string): string[] => {
      const tokens = new Set<string>();
      let run = "";
      const flush = (): void => {
        if (run) {
          addBigrams(run, tokens);
          run = "";
        }
      };
      const take = (term: string): void => {
        if (bigram && BIGRAM_SCRIPTS.test(term)) {
          run += term;
          return;
        }
        flush();
        tokens.add(term);
      };
      for (const segment of segmenter.segment(
        raw.normalize("NFC").toLowerCase()
      )) {
        if (!segment.isWordLike) {
          flush();
          continue;
        }
        let end = 0;
        for (const match of segment.segment.matchAll(TERM)) {
          // A gap means punctuation stood there, which ends the run as surely
          // as a non-word-like segment would: スネーク_ケース pairs either side
          // of the connector, never across it.
          if (match.index > end) {
            flush();
          }
          take(match[0]);
          end = match.index + match[0].length;
        }
        if (end < segment.segment.length) {
          flush();
        }
      }
      flush();
      return [...tokens];
    },
  };
};

/**
 * Build an in-memory Orama full-text index from search documents. Shared by the
 * Orama client loader (browser), the MCP server, and Ask AI grounding (Node),
 * so ranking is identical wherever docs are queried. `locale` — the site's
 * `i18n.defaultLocale` — swaps in a word-segmenting tokenizer for languages
 * written without spaces (Japanese, Chinese, Korean, Thai); the tokenizer
 * belongs to the database, so on a mixed-locale site it applies to every
 * document, which is safe because words in other scripts — Latin, and
 * mark-bearing scripts like Hebrew or Devanagari — survive segmentation
 * intact.
 */
export const buildOramaIndex = async (
  documents: OramaDoc[],
  locale?: string
): Promise<AnyOrama> => {
  const tokenizer = segmentingTokenizer(locale);
  const db = create({
    schema: SCHEMA,
    ...(tokenizer ? { components: { tokenizer } } : {}),
  });
  await insertMultiple(
    db,
    documents.map((doc) =>
      doc.facets ? { ...doc, facetTerms: toFacetTerms(doc.facets) } : doc
    )
  );
  return db;
};

/** Orama keeps only documents matching every token at a threshold of 0. */
const ALL_TOKENS = 0;

/** Optional exact-match filters applied to a query via Orama's `where`. */
export interface OramaQueryFilters {
  /** Keep only documents whose `contentType` is in this list. */
  contentTypes?: string[];
  /**
   * Keep only documents matching every facet, key → required value. Facet
   * keys and values come from the `facets` field on the indexed documents.
   */
  facets?: Record<string, string>;
  /** Keep only documents in this locale. */
  locale?: string;
}

/**
 * Query the index, returning the matching documents (highest-ranked first).
 * `filters` narrows results by exact `where` matches on the enum fields:
 * `locale` to one language, `contentTypes` to a set of page types, `facets`
 * to documents carrying every requested `key:value` term.
 *
 * On a bigrammed index the strict pass runs first: a term is only meant to
 * match where its bigrams sit together, and scoring them independently lets a
 * page sharing a couple of windows outrank the page the term is about. Terms
 * spanning several words rarely appear in full on one page, so an empty strict
 * result falls back to the default pass rather than reporting no matches.
 */
export const queryOramaIndex = async (
  db: AnyOrama,
  term: string,
  limit: number,
  filters?: OramaQueryFilters
): Promise<OramaDoc[]> => {
  const facetTerms = filters?.facets ? toFacetTerms(filters.facets) : [];
  const where = {
    ...(filters?.locale ? { locale: { eq: filters.locale } } : {}),
    ...(filters?.contentTypes && filters.contentTypes.length > 0
      ? { contentType: { in: filters.contentTypes } }
      : {}),
    ...(facetTerms.length > 0
      ? { facetTerms: { containsAll: facetTerms } }
      : {}),
  };
  const params = {
    boost: BOOST,
    limit,
    properties: ["title", "description", "content"],
    term,
    ...(Object.keys(where).length > 0 ? { where } : {}),
  };
  const bigrammed = BIGRAM_LANGUAGES.has(db.tokenizer?.language ?? "");
  const strict = bigrammed
    ? await search(db, { ...params, threshold: ALL_TOKENS })
    : undefined;
  const found =
    strict && strict.hits.length > 0 ? strict : await search(db, params);
  return found.hits.map((hit) => hit.document as unknown as OramaDoc);
};
