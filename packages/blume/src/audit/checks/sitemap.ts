import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type { AuditContext, CheckModule } from "../types.ts";
import { normalizePath, siteOrigin } from "../url.ts";

const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
const MAX_SITEMAP_URLS = 50_000;

/**
 * Slack for future `<lastmod>` values. A date-only stamp written in a timezone
 * ahead of UTC parses as "tomorrow" from behind it; a day of grace keeps that
 * from being reported as a lie.
 */
const LASTMOD_SLACK_MS = 24 * 60 * 60 * 1000;

/** Error routes are never crawlable destinations, so they belong out of the sitemap. */
const ERROR_ROUTES = new Set(["/404", "/500"]);

/** Site paths listed in the sitemap, normalized for comparison against page URLs. */
const sitemapPaths = (context: AuditContext): Map<string, string> => {
  const paths = new Map<string, string>();
  for (const loc of context.sitemap?.urls ?? []) {
    try {
      paths.set(normalizePath(new URL(loc).pathname), loc);
    } catch {
      // A malformed <loc> is reported by SITEMAP_INVALID, not here.
    }
  }
  return paths;
};

/** The path of a canonical URL, or null when it isn't parseable (CANONICAL_BAD_TARGET reports that). */
const canonicalPath = (canonical: string): string | null => {
  try {
    return normalizePath(new URL(canonical).pathname);
  } catch {
    return null;
  }
};

/** Validate one `<loc>` against the build: does it exist, and is it indexable? */
const checkListedUrl = (
  context: AuditContext,
  loc: string,
  origin: string | null,
  file: string
): Diagnostic[] => {
  let parsed: URL;
  try {
    parsed = new URL(loc);
  } catch {
    return [
      finding(
        "BLUME_AUDIT_SITEMAP_INVALID",
        { file, url: "/sitemap.xml" },
        `sitemap.xml lists "${loc}", which is not a valid absolute URL.`
      ),
    ];
  }

  if (origin && parsed.origin !== origin) {
    return [
      finding(
        "BLUME_AUDIT_SITEMAP_OUT_OF_SCOPE",
        { file, url: loc },
        `sitemap.xml lists ${loc}, which is on another origin.`
      ),
    ];
  }

  const path = normalizePath(parsed.pathname);
  const page = context.byUrl.get(path);
  if (!page) {
    const redirect = context.redirects.find(
      (entry) => normalizePath(entry.from) === path
    );
    return [
      finding(
        "BLUME_AUDIT_SITEMAP_BAD_URL",
        { file, url: loc },
        redirect
          ? `sitemap.xml lists ${path}, which redirects to ${redirect.to}.`
          : `sitemap.xml lists ${path}, which the build does not serve.`
      ),
    ];
  }

  const found: Diagnostic[] = [];
  if (!page.indexable) {
    found.push(
      finding(
        "BLUME_AUDIT_NOINDEX_IN_SITEMAP",
        pageSite(context, page, ["noindex"]),
        `${path} is in the sitemap but declares robots "${page.robots}".`
      )
    );
  }

  const canonical = page.canonical && canonicalPath(page.canonical);
  if (canonical && canonical !== path) {
    found.push(
      finding(
        "BLUME_AUDIT_NON_CANONICAL_IN_SITEMAP",
        pageSite(context, page, ["seo", "canonical"]),
        `${path} is in the sitemap but canonicalizes to ${canonical}.`
      )
    );
  }
  return found;
};

/**
 * The sitemap, cross-checked against what was actually built.
 *
 * The highest-value check here is the one Ahrefs buries at info severity:
 * `INDEXABLE_PAGE_NOT_IN_SITEMAP`. A page that a stray `draft: true` or
 * `sidebar.hidden` quietly kept out of the sitemap is invisible to search, and
 * nothing else in the toolchain tells you.
 */
export const sitemapChecks: CheckModule = {
  category: "sitemap",
  run(context) {
    const { sitemap } = context;
    const { site } = context.project.config.deployment;

    // Without `deployment.site` Blume can't emit a sitemap at all (absolute URLs
    // are required), and that's a config choice, not a defect. Stay quiet.
    if (!(site && context.project.config.seo.sitemap)) {
      return [];
    }

    if (!sitemap) {
      return [
        finding(
          "BLUME_AUDIT_SITEMAP_INVALID",
          { url: "/sitemap.xml" },
          "The build has no sitemap.xml.",
          "Set `seo.sitemap: true` and `deployment.site` in blume.config.ts."
        ),
      ];
    }

    const found: Diagnostic[] = [];
    if (sitemap.error) {
      found.push(
        finding(
          "BLUME_AUDIT_SITEMAP_INVALID",
          { file: sitemap.file, url: "/sitemap.xml" },
          `sitemap.xml is not a valid urlset: ${sitemap.error}`
        )
      );
      return found;
    }

    if (
      sitemap.bytes > MAX_SITEMAP_BYTES ||
      sitemap.urls.length > MAX_SITEMAP_URLS
    ) {
      found.push(
        finding(
          "BLUME_AUDIT_SITEMAP_TOO_LARGE",
          { file: sitemap.file, url: "/sitemap.xml" },
          `sitemap.xml holds ${sitemap.urls.length} URLs in ${Math.round(sitemap.bytes / 1024 / 1024)} MB.`
        )
      );
    }

    // A `<lastmod>` that lies — malformed, or claiming the future — teaches
    // search engines to distrust every lastmod in the file, which throws away
    // the recrawl-priority signal the field exists to provide.
    for (const [loc, lastmod] of sitemap.lastmod ?? []) {
      const time = Date.parse(lastmod);
      if (Number.isNaN(time)) {
        found.push(
          finding(
            "BLUME_AUDIT_SITEMAP_LASTMOD_INVALID",
            { file: sitemap.file, url: loc },
            `sitemap.xml gives ${loc} a lastmod of "${lastmod}", which is not a valid W3C date.`
          )
        );
      } else if (time > Date.now() + LASTMOD_SLACK_MS) {
        found.push(
          finding(
            "BLUME_AUDIT_SITEMAP_LASTMOD_INVALID",
            { file: sitemap.file, url: loc },
            `sitemap.xml gives ${loc} a lastmod of ${lastmod}, which is in the future.`
          )
        );
      }
    }

    const origin = siteOrigin(site);
    const listed = sitemapPaths(context);

    for (const loc of sitemap.urls) {
      found.push(...checkListedUrl(context, loc, origin, sitemap.file));
    }

    // The other direction: a page that was built, is indexable, and should be
    // findable — but never made it into the sitemap.
    for (const page of context.pages) {
      if (
        !page.indexable ||
        ERROR_ROUTES.has(page.url) ||
        listed.has(normalizePath(page.url))
      ) {
        continue;
      }
      found.push(
        finding(
          "BLUME_AUDIT_INDEXABLE_PAGE_NOT_IN_SITEMAP",
          pageSite(context, page),
          `${page.url} is built and indexable but is not listed in sitemap.xml.`
        )
      );
    }

    return found;
  },
  tier: "static",
};
