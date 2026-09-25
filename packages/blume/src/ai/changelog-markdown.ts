import { mountBasePath, normalizeBasePath } from "../core/base-path.ts";
import { EN_UI, resolveUIStrings } from "../core/i18n-ui.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { absoluteUrl } from "../core/site-url.ts";
import type { PageRecord } from "../core/types.ts";

/**
 * The generated `/changelog` index as Markdown, for its `/changelog.md`
 * mirror and MCP `get_page`: the timeline an agent would otherwise have to
 * scrape out of the rendered page. Lists what the index page lists — every
 * visible changelog entry of the current docs in the default locale, newest
 * first, grouped by year — one line each, with its date and category and a
 * link to the entry's own page.
 */

interface IndexRow {
  date: Date | null;
  page: PageRecord;
}

const parseDate = (value: string | undefined): Date | null => {
  if (value === undefined) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** A row's link: absolute under a configured site, like llms.txt. */
const entryUrl = (project: BlumeProject, route: string): string => {
  const { base, site } = project.config.deployment.options;
  const path = mountBasePath(normalizeBasePath(base), route);
  return encodeURI(site ? absoluteUrl(site, path) : path);
};

const rowLine = (project: BlumeProject, { date, page }: IndexRow): string => {
  const details = [
    date ? date.toISOString().slice(0, 10) : "",
    page.meta.changelog?.category ?? "",
  ].filter(Boolean);
  const title = page.title.replaceAll(/[[\]]/gu, String.raw`\$&`);
  const tail = details.length > 0 ? ` — ${details.join(", ")}` : "";
  return `- [${title}](${entryUrl(project, page.route)})${tail}`;
};

export const buildChangelogIndexMarkdown = (project: BlumeProject): string => {
  const { i18n } = project.config;
  const ui = i18n
    ? resolveUIStrings(i18n.defaultLocale, {
        defaultLocale: i18n.defaultLocale,
        overrides: i18n.ui,
      })
    : EN_UI;
  const rows: IndexRow[] = project.graph.pages
    .filter(
      (page) =>
        page.contentType === "changelog" &&
        !page.meta.draft &&
        !page.meta.sidebar.hidden &&
        !page.fallback &&
        page.version === "" &&
        (!i18n || page.locale === i18n.defaultLocale)
    )
    .map((page) => ({
      date: parseDate(page.meta.date ?? page.meta.changelog?.date),
      page,
    }))
    .toSorted((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));

  const blocks = [`# ${ui.changelog.title}`, ui.changelog.description];
  let year: number | null | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length > 0) {
      blocks.push(lines.join("\n"));
      lines = [];
    }
  };
  for (const row of rows) {
    const rowYear = row.date ? row.date.getUTCFullYear() : null;
    if (rowYear !== year) {
      flush();
      year = rowYear;
      // Undated entries sort last, under a heading of their own.
      blocks.push(rowYear === null ? "## Undated" : `## ${rowYear}`);
    }
    lines.push(rowLine(project, row));
  }
  flush();
  return `${blocks.join("\n\n")}\n`;
};
