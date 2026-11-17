import type { ResolvedDateFormat } from "./schema.ts";

/**
 * The default date presentation — the long form (`July 21, 2026`,
 * `2026年7月21日`) both stamps used before `dateFormat` was configurable.
 */
export const DEFAULT_DATE_FORMAT: ResolvedDateFormat = { dateStyle: "long" };

/**
 * Resolve a configured `dateFormat` into `Intl.DateTimeFormat` options for the
 * per-page "last updated" stamp and the changelog timeline. Both surfaces call
 * this so they format alike. Dates render in UTC unless the config names a
 * `timeZone`, so a stamp reads the same regardless of the build machine's zone.
 */
export const resolveDateFormatOptions = (
  format: ResolvedDateFormat = DEFAULT_DATE_FORMAT
): Intl.DateTimeFormatOptions => ({ timeZone: "UTC", ...format });

/**
 * A date's calendar day in `timeZone` as `YYYY-MM-DD`: the machine-readable
 * twin (a `<time datetime>`, a Markdown mirror's date) of a label formatted in
 * that zone, so the two name the same day.
 */
export const isoDateFormat = (
  timeZone: string | undefined
): ((date: Date) => string) => {
  const format = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  });
  return (date) => {
    const parts = new Map(
      format.formatToParts(date).map((part) => [part.type, part.value])
    );
    // Four digits, as ISO 8601 writes a year before 1000 (`0999`).
    const year = parts.get("year")?.padStart(4, "0");
    return `${year}-${parts.get("month")}-${parts.get("day")}`;
  };
};

/**
 * An {@link isoDateFormat} day's year (all before `-MM-DD`) as a heading
 * writes it: `0999` is `999`, `10000` stays whole.
 */
export const isoDayYear = (day: string): string =>
  String(Number(day.slice(0, -6)));
