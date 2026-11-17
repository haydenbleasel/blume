/**
 * The policy the dated indexes list by — the changelog's and the blog's —
 * shared by the surfaces that build them: the `<Changelog />` and `<Blog />`
 * components and their Markdown mirrors (`/changelog.md`, `/blog.md`, MCP
 * `get_page`), and the sidebar's year groups.
 *
 * The data sources genuinely differ — a collection entry on the Astro side, a
 * `PageRecord` on the Node side — so what lives here is the *decisions*, not
 * the access: which date a row carries, what order rows come in, and how they
 * fall into year groups. Keeping them in one place is what stops the rendered
 * page and the Markdown an agent reads from drifting apart.
 */

/**
 * A dated entry's (a blog post's, a changelog entry's) date as written: front
 * matter `date`, else the `changelog.date` a changelog entry may keep it
 * under, else the git date `seo.datePublished: "git"` gives an undated page.
 * Every surface that dates an entry reads it here, so the sidebar, the index,
 * the feed, and the page agree.
 */
export const entryDate = (page: {
  meta: { changelog?: { date?: string }; date?: string };
  published?: string;
}): string | undefined =>
  page.meta.date ?? page.meta.changelog?.date ?? page.published;

/**
 * An entry's date, from `date` or the `changelog.date` a changelog entry may
 * keep it under instead. Front matter hands either a `Date` (an unquoted YAML
 * date) or a string, and an unparseable value is treated as no date at all
 * rather than failing the build — a malformed date costs the row its stamp and
 * its year group, not the page.
 */
export const parseEntryDate = (
  value: Date | string | null | undefined
): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Newest first, undated last: undated rows collect at the end of the list
 * (and, through {@link groupEntryYears}, into a final group with no year
 * label), after an entry dated before 1970 too, as in the sidebar.
 */
export const compareEntryDates = (a: Date | null, b: Date | null): number => {
  if (a === null || b === null) {
    return Number(a === null) - Number(b === null);
  }
  return b.getTime() - a.getTime();
};

/** One year's run of rows. `year` is `null` for the undated group. */
export interface EntryYearGroup<T> {
  items: T[];
  year: string | null;
}

/**
 * Consecutive rows sharing a year, in list order, so the index reads as a year
 * rail beside its rows. Runs are consecutive rather than keyed, which matters
 * only for a list that isn't sorted by date: such a list keeps its order and
 * repeats the year heading instead of silently regrouping around it.
 *
 * `yearOf` returns the label the surface wants — a locale-formatted year on the
 * rendered page, a plain number in Markdown — or `null` for an undated row.
 */
export const groupEntryYears = <T>(
  items: T[],
  yearOf: (item: T) => string | null
): EntryYearGroup<T>[] => {
  const groups: EntryYearGroup<T>[] = [];
  for (const item of items) {
    const year = yearOf(item);
    const last = groups.at(-1);
    if (last && last.year === year) {
      last.items.push(item);
    } else {
      groups.push({ items: [item], year });
    }
  }
  return groups;
};

/**
 * Make each row's anchor unique. Repeated labels slug to the same id (two
 * entries with neither a title nor a version both fall back to "update"), so
 * the later ones take a `-2`, `-3`, … suffix and the first keeps the plain
 * slug — every row ends up with its own hash anchor.
 */
export const uniqueAnchorIds = (ids: string[]): string[] => {
  const seen = new Set<string>();
  return ids.map((id) => {
    let unique = id;
    for (let n = 2; seen.has(unique); n += 1) {
      unique = `${id}-${n}`;
    }
    seen.add(unique);
    return unique;
  });
};
