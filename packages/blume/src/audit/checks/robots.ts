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

const USER_AGENT_LINE = /^\s*user-agent\s*:\s*(?<agent>[^#]*)/iu;

/**
 * The crawlers robots.txt names in a `User-agent` line, other than `*`, as
 * written (first spelling wins). robots-parser matches a group by the token
 * before any `/version`, case-insensitively, so that's what dedupes them.
 */
const namedAgents = (raw: string): string[] => {
  const agents = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const agent = USER_AGENT_LINE.exec(line)?.groups?.agent?.trim() ?? "";
    const key = agent.toLowerCase().split("/")[0]?.trim() ?? "";
    if (key && key !== "*" && !agents.has(key)) {
      agents.set(key, agent);
    }
  }
  return [...agents.values()];
};

/**
 * robots.txt: is it there, is it well-formed, does it point at the sitemap, and
 * — the one that matters — does it block a page the sitemap is advertising?
 * Blocking every crawler (`User-agent: *`) is an error; a group aimed at one
 * crawler is a warning, since shutting out an AI crawler is often on purpose.
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

    // Blume only writes the Sitemap line when there is a sitemap to point at.
    if (
      site &&
      context.project.config.seo.sitemap &&
      robots.sitemaps.length === 0
    ) {
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
    const ruleAt = (url: string, agent: string) => {
      const line = parser.getMatchingLineNumber(url, agent);
      return { line, rule: line > 0 ? lines[line - 1]?.trim() : undefined };
    };
    // A crawler named in its own group follows only that group, so a rule
    // there can block it from a page every other crawler may read.
    const agents = namedAgents(robots.raw);
    const blockedFor = new Map<string, string[]>();
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
        const { rule } = ruleAt(url, "*");
        found.push(
          finding(
            "BLUME_AUDIT_ROBOTS_DISALLOWS_INDEXABLE",
            { file: robots.file, url: path },
            `robots.txt "${rule ?? "Disallow"}" blocks ${path}, which sitemap.xml advertises.`
          )
        );
        continue;
      }
      for (const agent of agents) {
        if (!parser.isDisallowed(url, agent)) {
          continue;
        }
        const blocked = blockedFor.get(agent);
        if (blocked) {
          blocked.push(url);
        } else {
          blockedFor.set(agent, [url]);
        }
      }
    }

    // One finding per crawler, at the rule that blocks its first page: a
    // `Disallow: /` aimed at one bot would otherwise list every page.
    for (const [agent, urls] of blockedFor) {
      const [first = ""] = urls;
      const { line, rule } = ruleAt(first, agent);
      const path = normalizePath(new URL(first).pathname);
      const more = urls.length > 1 ? ` and ${urls.length - 1} more` : "";
      found.push(
        finding(
          "BLUME_AUDIT_ROBOTS_BLOCKS_CRAWLER",
          { file: robots.file, line, url: "/robots.txt" },
          `robots.txt "${rule ?? "Disallow"}" blocks ${agent} from ${path}${more}, which sitemap.xml advertises.`
        )
      );
    }

    return found;
  },
  tier: "static",
};
