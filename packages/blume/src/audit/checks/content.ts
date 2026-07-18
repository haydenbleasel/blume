import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import { ERROR_ROUTES } from "../types.ts";
import type { AuditContext, CheckModule, PageSnapshot } from "../types.ts";

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
        ...headingChecks(context, page)
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
