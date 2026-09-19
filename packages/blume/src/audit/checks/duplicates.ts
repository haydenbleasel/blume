import { normalizeBasePath, stripBasePath } from "../../core/base-path.ts";
import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import type { CheckId } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type { AuditContext, CheckModule, PageSnapshot } from "../types.ts";
import { decodePath } from "../url.ts";

const isNonCanonical = (page: PageSnapshot, deployBase: string): boolean => {
  if (!page.canonical) {
    return false;
  }
  try {
    // Canonicals are emitted as `site + base + route`; page URLs carry no
    // deployment base — without stripping it, every page of a subpath
    // deployment would look non-canonical and escape these checks entirely.
    return (
      stripBasePath(
        deployBase,
        decodePath(new URL(page.canonical).pathname)
      ).replace(/\/$/u, "") !== page.url.replace(/\/$/u, "")
    );
  } catch {
    return false;
  }
};

/** Pages that can meaningfully be compared against each other for duplication. */
const comparable = (context: AuditContext): PageSnapshot[] => {
  const deployBase = normalizeBasePath(
    context.project.config.deployment.options.base
  );
  return context.pages.filter(
    (page) =>
      page.indexable &&
      // A fallback page renders the default locale's content at a localized URL.
      // It is *supposed* to be an exact copy, so comparing it would make every
      // i18n site with an untranslated page a wall of false positives.
      !page.route?.fallback &&
      // A page that points its canonical elsewhere has already declared itself a
      // duplicate; that's the mechanism working, not a finding.
      !isNonCanonical(page, deployBase)
  );
};

/**
 * Group pages by a value and report every group with more than one member.
 * Translations are kept apart by keying on locale as well as the value — two
 * pages titled "Overview" in different languages are not duplicates.
 */
const reportGroups = (
  context: AuditContext,
  pages: PageSnapshot[],
  id: CheckId,
  key: (page: PageSnapshot) => string | undefined,
  describe: (value: string, others: PageSnapshot[]) => string,
  frontmatterKey?: readonly string[]
): Diagnostic[] => {
  const groups = new Map<string, PageSnapshot[]>();
  for (const page of pages) {
    const value = key(page);
    if (!value) {
      continue;
    }
    const groupKey = `${page.route?.locale ?? ""}\u0000${value}`;
    const group = groups.get(groupKey);
    if (group) {
      group.push(page);
    } else {
      groups.set(groupKey, [page]);
    }
  }

  const found: Diagnostic[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const page of group) {
      const others = group.filter((other) => other !== page);
      found.push(
        finding(
          id,
          pageSite(context, page, frontmatterKey),
          describe(key(page) ?? "", others)
        )
      );
    }
  }
  return found;
};

const list = (pages: PageSnapshot[]): string => {
  const shown = pages.slice(0, 3).map((page) => page.url);
  const rest = pages.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
};

/**
 * Pages that collide on title, description, or body text.
 *
 * Ahrefs only reports "duplicate pages without canonical". Duplicate *titles*
 * and *descriptions* are the ones that actually bite a docs site — five pages
 * called "Overview" all compete for the same result headline — so they're
 * reported too.
 */
export const duplicateChecks: CheckModule = {
  category: "duplicates",
  run(context) {
    const pages = comparable(context);
    return [
      ...reportGroups(
        context,
        pages,
        "BLUME_AUDIT_DUPLICATE_TITLE",
        (page) => page.titles[0],
        (value, others) => `Title "${value}" is also used by ${list(others)}.`,
        ["title"]
      ),
      ...reportGroups(
        context,
        pages,
        "BLUME_AUDIT_DUPLICATE_DESCRIPTION",
        (page) => page.descriptions[0],
        (_value, others) => `Meta description is identical to ${list(others)}.`,
        ["description"]
      ),
      ...reportGroups(
        context,
        // An empty page (no prose at all) hashes the same as every other empty
        // page; that's a content problem LOW_WORD_COUNT already reports, not a
        // duplication one.
        pages.filter((page) => page.wordCount > 0),
        "BLUME_AUDIT_DUPLICATE_CONTENT",
        (page) => page.contentHash,
        (_value, others) =>
          `Page content is byte-identical to ${list(others)}, and none declares a canonical.`
      ),
    ];
  },
  tier: "static",
};
