import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import type { CheckModule } from "../types.ts";
import { normalizePath } from "../url.ts";

/**
 * Whether a robots.txt `Disallow` value covers a path. robots.txt matching is
 * prefix-based, with `*` as a wildcard and `$` anchoring the end.
 */
export const disallowMatches = (rule: string, path: string): boolean => {
  const anchored = rule.endsWith("$");
  const pattern = anchored ? rule.slice(0, -1) : rule;
  const parts = pattern.split("*");

  let cursor = 0;
  for (const [index, part] of parts.entries()) {
    if (part === "") {
      continue;
    }
    // The first segment is anchored to the start of the path (robots.txt rules
    // are prefix matches); every later segment may appear anywhere after the
    // previous one, which is what makes `*` a wildcard.
    let at: number;
    if (index === 0) {
      at = path.startsWith(part) ? 0 : -1;
    } else {
      at = path.indexOf(part, cursor);
    }
    if (at === -1) {
      return false;
    }
    cursor = at + part.length;
  }
  return anchored ? cursor === path.length : true;
};

/**
 * robots.txt: is it there, is it well-formed, does it point at the sitemap, and
 * — the one that matters — does it block a page the sitemap is advertising?
 *
 * Ahrefs also tracks "robots.txt has too many redirects". A static host serves
 * the file directly, so that is effectively unreachable here and isn't checked.
 */
export const robotsChecks: CheckModule = {
  category: "robots",
  run(context) {
    const { robots } = context;
    const { site } = context.project.config.deployment;

    if (!context.project.config.seo.robots) {
      return [];
    }

    if (!robots) {
      return [
        finding(
          "BLUME_AUDIT_ROBOTS_MISSING",
          { url: "/robots.txt" },
          "The build has no robots.txt."
        ),
      ];
    }

    const found: Diagnostic[] = robots.invalid.map((line) =>
      finding(
        "BLUME_AUDIT_ROBOTS_INVALID",
        { file: robots.file, line: line.line, url: "/robots.txt" },
        `robots.txt line ${line.line} is not a directive: "${line.text}"`
      )
    );

    if (site && robots.sitemaps.length === 0) {
      found.push(
        finding(
          "BLUME_AUDIT_ROBOTS_SITEMAP_MISSING",
          { file: robots.file, url: "/robots.txt" },
          "robots.txt does not declare a Sitemap."
        )
      );
    }

    // A page can't be both blocked from crawling and advertised for indexing.
    // Checking the disallow rules against the sitemap (rather than against every
    // built file) keeps this to the pages the site actually wants indexed.
    for (const loc of context.sitemap?.urls ?? []) {
      let path: string;
      try {
        path = normalizePath(new URL(loc).pathname);
      } catch {
        continue;
      }
      const rule = robots.disallow.find((entry) =>
        disallowMatches(entry, path)
      );
      if (rule) {
        found.push(
          finding(
            "BLUME_AUDIT_ROBOTS_DISALLOWS_INDEXABLE",
            { file: robots.file, url: path },
            `robots.txt "Disallow: ${rule}" blocks ${path}, which sitemap.xml advertises.`
          )
        );
      }
    }

    return found;
  },
  tier: "static",
};
