/**
 * The changelog's list policy, under the names it had before the blog came to
 * share it. Moved to `dated-list.ts`; these stay for code that imports them
 * from `blume/core/changelog-list.ts`.
 */
export {
  compareEntryDates as compareChangelogDates,
  groupEntryYears as groupChangelogYears,
  parseEntryDate as parseChangelogDate,
  uniqueAnchorIds,
} from "./dated-list.ts";
export type { EntryYearGroup as ChangelogYearGroup } from "./dated-list.ts";
