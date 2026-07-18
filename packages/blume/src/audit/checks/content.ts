import matter from "../../core/frontmatter.ts";
import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import { ERROR_ROUTES } from "../types.ts";
import type { AuditContext, CheckModule, PageSnapshot } from "../types.ts";

/**
 * The `date` a source file's front matter declares, when it parses to a real
 * date. YAML hands back a `Date` for an unquoted `2026-01-01` and a string for
 * a quoted one, so both spellings are accepted; malformed front matter or an
 * unparseable value simply yields nothing — `BLUME_FRONTMATTER_INVALID` is the
 * build's finding, not the audit's.
 */
const frontmatterDate = (source: string): Date | null => {
  try {
    const { date } = matter(source).data as { date?: unknown };
    if (typeof date !== "string" && !(date instanceof Date)) {
      return null;
    }
    const parsed = date instanceof Date ? date : new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
};

const titleChecks = (
  context: AuditContext,
  page: PageSnapshot
): Diagnostic[] => {
  const { titleMin, titleMax } = context.thresholds;
  const [title] = page.titles;

  if (!title) {
    return [
      finding(
        "BLUME_AUDIT_TITLE_MISSING",
        pageSite(context, page),
        "Page has no <title>."
      ),
    ];
  }

  const found: Diagnostic[] = [];
  if (page.titles.length > 1) {
    found.push(
      finding(
        "BLUME_AUDIT_TITLE_MULTIPLE",
        pageSite(context, page),
        `Page has ${page.titles.length} <title> tags; search engines use only the first.`
      )
    );
  }
  if (title.length > titleMax || title.length < titleMin) {
    const direction = title.length > titleMax ? "long" : "short";
    found.push(
      finding(
        "BLUME_AUDIT_TITLE_LENGTH",
        pageSite(context, page, ["title"]),
        `Title is ${title.length} characters — too ${direction} (aim for ${titleMin}–${titleMax}).`
      )
    );
  }
  return found;
};

const descriptionChecks = (
  context: AuditContext,
  page: PageSnapshot
): Diagnostic[] => {
  // An error route is noindex by design, so its description never renders as
  // a search snippet — grading it would put a guaranteed finding on every
  // site whose 404 inherits the site-default description.
  if (ERROR_ROUTES.has(page.url)) {
    return [];
  }

  const { descriptionMin, descriptionMax } = context.thresholds;
  const [description] = page.descriptions;

  if (!description) {
    return [
      finding(
        "BLUME_AUDIT_DESCRIPTION_MISSING",
        pageSite(context, page),
        "Page has no meta description."
      ),
    ];
  }

  const found: Diagnostic[] = [];
  if (page.descriptions.length > 1) {
    found.push(
      finding(
        "BLUME_AUDIT_DESCRIPTION_MULTIPLE",
        pageSite(context, page),
        `Page has ${page.descriptions.length} meta description tags.`
      )
    );
  }
  if (
    description.length > descriptionMax ||
    description.length < descriptionMin
  ) {
    const direction = description.length > descriptionMax ? "long" : "short";
    found.push(
      finding(
        "BLUME_AUDIT_DESCRIPTION_LENGTH",
        pageSite(context, page, ["description"]),
        `Meta description is ${description.length} characters — too ${direction} (aim for ${descriptionMin}–${descriptionMax}).`
      )
    );
  }
  return found;
};

const headingChecks = (
  context: AuditContext,
  page: PageSnapshot
): Diagnostic[] => {
  const h1s = page.headings.filter((heading) => heading.depth === 1);
  if (h1s.length === 0) {
    return [
      finding(
        "BLUME_AUDIT_H1_MISSING",
        pageSite(context, page),
        "Page has no <h1>."
      ),
    ];
  }
  if (h1s.length > 1) {
    return [
      finding(
        "BLUME_AUDIT_H1_MULTIPLE",
        pageSite(context, page),
        `Page has ${h1s.length} <h1> tags: ${h1s.map((h) => `"${h.text}"`).join(", ")}.`
      ),
    ];
  }

  // A skipped level (h2 -> h4) breaks table-of-contents nesting and screen-
  // reader outlines. The first skip is the finding — one wrong heading early
  // in a page cascades, and listing every knock-on skip buries the fix.
  let previous: number | null = null;
  for (const heading of page.headings) {
    if (previous !== null && heading.depth > previous + 1) {
      return [
        finding(
          "BLUME_AUDIT_HEADING_SKIP",
          pageSite(context, page),
          `Headings jump from h${previous} to h${heading.depth} at "${heading.text}".`
        ),
      ];
    }
    previous = heading.depth;
  }
  return [];
};

/**
 * A page dated in the future usually means scheduled content that leaked into
 * the build early. Only the front matter knows — the rendered page looks
 * perfectly ordinary.
 */
const futureDateChecks = (
  context: AuditContext,
  page: PageSnapshot
): Diagnostic[] => {
  const source = page.source && context.sources.get(page.source);
  if (!source) {
    return [];
  }
  const date = frontmatterDate(source);
  if (date && date.getTime() > Date.now()) {
    return [
      finding(
        "BLUME_AUDIT_FUTURE_DATED_PAGE",
        pageSite(context, page, ["date"]),
        `Page is dated ${date.toISOString().slice(0, 10)}, which is in the future.`
      ),
    ];
  }
  return [];
};

/**
 * Per-page head and body content: title, description, headings, word count,
 * viewport.
 *
 * Ahrefs reports each of these twice — once for indexable pages and once for
 * non-indexable ones. That's a crawler artifact: the finding is the same either
 * way, so it's reported once and the page's indexability rides along on the
 * snapshot.
 */
export const contentChecks: CheckModule = {
  category: "content",
  run(context) {
    const found: Diagnostic[] = [];
    for (const page of context.pages) {
      found.push(
        ...titleChecks(context, page),
        ...descriptionChecks(context, page),
        ...headingChecks(context, page),
        ...futureDateChecks(context, page)
      );

      if (page.wordCount < context.thresholds.minWordCount && page.indexable) {
        found.push(
          finding(
            "BLUME_AUDIT_LOW_WORD_COUNT",
            pageSite(context, page),
            `Page has ${page.wordCount} words of prose (excluding code blocks).`
          )
        );
      }

      if (!page.viewport) {
        found.push(
          finding(
            "BLUME_AUDIT_VIEWPORT_MISSING",
            pageSite(context, page),
            "Page has no viewport <meta> — it will not render correctly on mobile."
          )
        );
      }
    }
    return found;
  },
  tier: "static",
};
