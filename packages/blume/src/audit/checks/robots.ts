import robotsParser from "robots-parser";

import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import type { CheckModule } from "../types.ts";
import { normalizePath } from "../url.ts";

/**
 * robots-parser needs full URLs on a single origin; the origin itself is
 * irrelevant to path matching, so a fixed placeholder keeps the check
 * independent of whether the project configured `deployment.site`.
 */
const MATCH_ORIGIN = "https://robots-audit.invalid";

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
    const { site } = context.project.config.deployment.options;

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
    // Checking the rules against the sitemap (rather than against every built
    // file) keeps this to the pages the site actually wants indexed.
    // robots-parser resolves Allow/Disallow by longest match, so the common
    // `Disallow: /` + `Allow: /docs/` pattern doesn't flag every page, and
    // consecutive User-agent lines form one group as the spec requires.
    const parser = robotsParser(`${MATCH_ORIGIN}/robots.txt`, robots.raw);
    const lines = robots.raw.split(/\r?\n/u);
    for (const loc of context.sitemap?.urls ?? []) {
      let pathname: string;
      try {
        ({ pathname } = new URL(loc));
      } catch {
        continue;
      }
      // Match the pathname as served: robots.txt rules are literal prefixes,
      // so `Disallow: /page/` must see the trailing slash to match.
      const path = normalizePath(pathname);
      const url = `${MATCH_ORIGIN}${pathname}`;
      if (parser.isDisallowed(url, "*")) {
        const line = parser.getMatchingLineNumber(url, "*");
        const rule = line > 0 ? lines[line - 1]?.trim() : undefined;
        found.push(
          finding(
            "BLUME_AUDIT_ROBOTS_DISALLOWS_INDEXABLE",
            { file: robots.file, url: path },
            `robots.txt "${rule ?? "Disallow"}" blocks ${path}, which sitemap.xml advertises.`
          )
        );
      }
    }

    return found;
  },
  tier: "static",
};
