/**
 * A page's `search.boost` and `search.keywords`, as Pagefind reads them from
 * the built page. Pagefind has no page-level boost, only element weights, so
 * the page's body carries its boost as its weight: a boosted page's matches
 * count for more and it ranks higher. Pagefind damps repeated matches, so the
 * lift is smaller than the full multiplier: a boost of 5 scored its page about
 * 1.5 to 2 times higher in testing. A boost past Pagefind's largest weight,
 * 10, counts as 10.
 * Keywords go on an empty element as an indexed attribute, found like text
 * and never shown.
 */

/** The largest weight Pagefind takes. */
const MAX_WEIGHT = 10;

/** The attribute a page's keywords ride on. */
export const KEYWORDS_ATTRIBUTE = "data-blume-keywords";

/** What the page body carries for Pagefind. */
export interface PagefindRanking {
  /** `data-pagefind-weight` for the body, when the page is boosted. */
  weight?: string;
  /** The keywords, space-separated, when the page sets any. */
  keywords?: string;
}

export const pagefindRanking = (search: {
  boost?: number;
  keywords?: string[];
}): PagefindRanking => {
  const { boost, keywords } = search;
  return {
    ...(boost !== undefined &&
      boost !== 1 && {
        weight: String(Math.min(boost, MAX_WEIGHT)),
      }),
    ...(keywords && keywords.length > 0 && { keywords: keywords.join(" ") }),
  };
};
