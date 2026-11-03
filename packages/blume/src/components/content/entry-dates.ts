import {
  isoDateFormat,
  resolveDateFormatOptions,
} from "../../core/date-format.ts";
import type { ResolvedDateFormat } from "../../core/schema.ts";

/** How a dated index (the changelog, the blog) writes its dates. */
export interface EntryDateFormats {
  /** A row's date: the full date, as the configured `dateFormat` writes it. */
  full: (date: Date) => string;
  /** A `<time datetime>`: the day the labels name, as `YYYY-MM-DD`. */
  iso: (date: Date) => string;
  /** A row's date beneath its year heading: the date without the year. */
  row: (date: Date) => string;
  /** A year heading. */
  year: (date: Date) => string;
}

/**
 * `locale`, or English where `Intl` can't read the code (`pt_BR`), as the
 * sidebar's period labels fall back: a page in that locale still builds.
 */
const readableLocale = (locale: string): string => {
  try {
    // Throws on a malformed tag, as `Intl.DateTimeFormat` itself would.
    Intl.DateTimeFormat.supportedLocalesOf(locale);
    return locale;
  } catch {
    return "en";
  }
};

/**
 * The date formats of a dated index, in the reader's `locale`, from the
 * configured `dateFormat`. A row under a year heading shows the rest of the
 * date: a preset style keeps its month wording, a component format simply
 * drops the year.
 */
export const entryDateFormats = (
  dateFormat: ResolvedDateFormat | undefined,
  pageLocale: string
): EntryDateFormats => {
  const locale = readableLocale(pageLocale);
  const options = resolveDateFormatOptions(dateFormat);
  const { dateStyle, year: _year, ...dateComponents } = options;
  const rowOptions: Intl.DateTimeFormatOptions = dateStyle
    ? {
        ...dateComponents,
        day: "numeric",
        // `medium` abbreviates the month; every other preset spells it out, so
        // a `long` site keeps reading "October 5" rather than dropping to
        // "Oct 5".
        month: dateStyle === "medium" ? "short" : "long",
      }
    : dateComponents;
  const full = new Intl.DateTimeFormat(locale, options);
  const row = new Intl.DateTimeFormat(locale, rowOptions);
  const year = new Intl.DateTimeFormat(locale, {
    timeZone: options.timeZone,
    year: "numeric",
  });
  return {
    full: (date) => full.format(date),
    iso: isoDateFormat(options.timeZone),
    row: (date) => row.format(date),
    year: (date) => year.format(date),
  };
};
