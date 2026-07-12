import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type { AuditContext, CheckModule, PageSnapshot } from "../types.ts";
import { normalizePath } from "../url.ts";

/** The hreflang value meaning "use this when nothing else matches". Not a locale. */
const X_DEFAULT = "x-default";

const isValidBcp47 = (tag: string): boolean => {
  try {
    Intl.getCanonicalLocales(tag);
    return true;
  } catch {
    return false;
  }
};

/** The site path an hreflang `href` points at, or null when it isn't parseable. */
const alternatePath = (href: string): string | null => {
  try {
    return normalizePath(new URL(href).pathname);
  } catch {
    return null;
  }
};

const langChecks = (
  context: AuditContext,
  page: PageSnapshot
): Diagnostic[] => {
  if (!page.lang) {
    return [
      finding(
        "BLUME_AUDIT_HTML_LANG_MISSING",
        pageSite(context, page),
        "The <html> element has no lang attribute."
      ),
    ];
  }
  if (!isValidBcp47(page.lang)) {
    return [
      finding(
        "BLUME_AUDIT_HTML_LANG_INVALID",
        pageSite(context, page),
        `"${page.lang}" is not a valid BCP 47 language tag.`
      ),
    ];
  }
  return [];
};

/**
 * Every hreflang finding for one page: validity, self-reference, x-default, and
 * whether each alternate points at a real, canonical page.
 */
const hreflangChecks = (
  context: AuditContext,
  page: PageSnapshot
): Diagnostic[] => {
  const found: Diagnostic[] = [];
  const seen = new Map<string, string[]>();

  for (const alternate of page.hreflang) {
    if (alternate.lang !== X_DEFAULT && !isValidBcp47(alternate.lang)) {
      found.push(
        finding(
          "BLUME_AUDIT_HREFLANG_INVALID",
          pageSite(context, page),
          `hreflang="${alternate.lang}" is not a valid BCP 47 language tag.`
        )
      );
      continue;
    }

    const hrefs = seen.get(alternate.lang) ?? [];
    hrefs.push(alternate.href);
    seen.set(alternate.lang, hrefs);

    const path = alternatePath(alternate.href);
    if (path === null) {
      found.push(
        finding(
          "BLUME_AUDIT_HREFLANG_BAD_TARGET",
          pageSite(context, page),
          `hreflang="${alternate.lang}" points at "${alternate.href}", which is not an absolute URL.`
        )
      );
      continue;
    }

    const target = context.byUrl.get(path);
    const redirect = context.redirects.find(
      (entry) => normalizePath(entry.from) === path
    );
    if (redirect) {
      found.push(
        finding(
          "BLUME_AUDIT_HREFLANG_BAD_TARGET",
          pageSite(context, page),
          `hreflang="${alternate.lang}" points at ${path}, which redirects to ${redirect.to}.`
        )
      );
    } else if (!target) {
      found.push(
        finding(
          "BLUME_AUDIT_HREFLANG_BAD_TARGET",
          pageSite(context, page),
          `hreflang="${alternate.lang}" points at ${path}, which the build does not serve.`
        )
      );
    } else if (
      target.canonical &&
      alternatePath(target.canonical) !== normalizePath(target.url)
    ) {
      found.push(
        finding(
          "BLUME_AUDIT_HREFLANG_BAD_TARGET",
          pageSite(context, page),
          `hreflang="${alternate.lang}" points at ${path}, which canonicalizes elsewhere.`
        )
      );
    }
  }

  // One language may name exactly one page.
  for (const [lang, hrefs] of seen) {
    if (hrefs.length > 1) {
      found.push(
        finding(
          "BLUME_AUDIT_HREFLANG_CONFLICT",
          pageSite(context, page),
          `hreflang="${lang}" is declared ${hrefs.length} times, pointing at ${hrefs.join(", ")}.`
        )
      );
    }
  }

  const self = page.hreflang.find(
    (alternate) => alternatePath(alternate.href) === normalizePath(page.url)
  );
  if (self) {
    if (page.lang && self.lang !== X_DEFAULT && self.lang !== page.lang) {
      found.push(
        finding(
          "BLUME_AUDIT_HREFLANG_LANG_MISMATCH",
          pageSite(context, page),
          `Page declares <html lang="${page.lang}"> but its own hreflang is "${self.lang}".`
        )
      );
    }
  } else {
    found.push(
      finding(
        "BLUME_AUDIT_HREFLANG_SELF_MISSING",
        pageSite(context, page),
        "Page's hreflang set does not include a self-reference."
      )
    );
  }

  if (!page.hreflang.some((alternate) => alternate.lang === X_DEFAULT)) {
    found.push(
      finding(
        "BLUME_AUDIT_HREFLANG_XDEFAULT_MISSING",
        pageSite(context, page),
        "Page's hreflang set has no x-default alternate."
      )
    );
  }

  return found;
};

/**
 * Reciprocity: if A names B as its alternate, B must name A back. Google ignores
 * a whole hreflang group when the return tags don't line up.
 *
 * This is the hardest check for a real crawler — it has to hold the entire site
 * in memory and cross-reference it. We already do.
 */
const returnTagChecks = (context: AuditContext): Diagnostic[] => {
  const found: Diagnostic[] = [];
  for (const page of context.pages) {
    for (const alternate of page.hreflang) {
      if (alternate.lang === X_DEFAULT) {
        continue;
      }
      const path = alternatePath(alternate.href);
      if (path === null || path === normalizePath(page.url)) {
        continue;
      }
      const target = context.byUrl.get(path);
      if (!target || target.hreflang.length === 0) {
        // A missing or hreflang-less target is already reported as a bad target.
        continue;
      }
      const returns = target.hreflang.some(
        (back) => alternatePath(back.href) === normalizePath(page.url)
      );
      if (!returns) {
        found.push(
          finding(
            "BLUME_AUDIT_HREFLANG_NO_RETURN_TAG",
            pageSite(context, page),
            `Page names ${path} as its "${alternate.lang}" alternate, but ${path} does not name it back.`
          )
        );
      }
    }
  }
  return found;
};

/**
 * Language declarations: `<html lang>` on every page, plus the full hreflang
 * cluster on pages that have translations.
 *
 * The hreflang checks are gated on the page actually carrying hreflang tags
 * rather than on `config.i18n`, so a monolingual site sees exactly zero of them
 * — but still gets its `<html lang>` validated, which is a real bug on any site.
 */
export const i18nChecks: CheckModule = {
  category: "i18n",
  run(context) {
    const found: Diagnostic[] = [];
    for (const page of context.pages) {
      found.push(...langChecks(context, page));
      if (page.hreflang.length > 0) {
        found.push(...hreflangChecks(context, page));
      }
    }
    found.push(...returnTagChecks(context));
    return found;
  },
  tier: "static",
};
