import { gradeExternal, probeAll } from "../../core/probe.ts";
import type { ProbeResult } from "../../core/probe.ts";
import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type { AuditContext, CheckModule, PageSnapshot } from "../types.ts";
import { resolveHref, siteOrigin } from "../url.ts";

const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;
/** Past this, a page is slow enough that it costs you crawl budget and readers. */
const SLOW_MS = 1500;

/** The live URL a built page is served at, under the `--url` origin. */
const liveUrl = (origin: string, page: PageSnapshot): string =>
  new URL(page.url, origin).toString();

/**
 * Whether the response failed outright, and how. Null when the page is served.
 *
 * Exported so the grading can be unit-tested against synthetic responses: a
 * timeout, an HTTPS-to-HTTP downgrade, and a slow first byte are all awkward to
 * provoke from a local test server, and faking the network to test them would
 * only be testing the fake.
 */
export const badResponse = (
  context: AuditContext,
  page: PageSnapshot,
  result: ProbeResult
): Diagnostic | null => {
  const site = pageSite(context, page);

  if (result.timedOut) {
    return finding(
      "BLUME_AUDIT_HTTP_TIMEOUT",
      site,
      `${page.url} did not respond within the timeout.`
    );
  }

  const { status } = result;
  if (status !== undefined && status >= SERVER_ERROR) {
    return finding(
      "BLUME_AUDIT_HTTP_5XX",
      site,
      `${page.url} returned HTTP ${status}.`
    );
  }
  if (status !== undefined && status >= CLIENT_ERROR) {
    return finding(
      "BLUME_AUDIT_HTTP_4XX",
      site,
      `${page.url} is in the build but returned HTTP ${status}.`
    );
  }
  if (!result.ok) {
    return finding(
      "BLUME_AUDIT_HTTP_5XX",
      site,
      `${page.url} is unreachable: ${result.error ?? "no response"}.`
    );
  }
  return null;
};

/** What a *successful* response still gets wrong: headers, timing, protocol. */
export const servedPageChecks = (
  context: AuditContext,
  page: PageSnapshot,
  result: ProbeResult,
  origin: string
): Diagnostic[] => {
  const site = pageSite(context, page);
  const found: Diagnostic[] = [];

  // A page served over HTTPS that redirects down to HTTP hands the reader to an
  // insecure connection — the opposite of the usual upgrade.
  if (
    result.redirected &&
    result.finalUrl?.startsWith("http://") &&
    origin.startsWith("https://")
  ) {
    found.push(
      finding(
        "BLUME_AUDIT_REDIRECT_TO_HTTP",
        site,
        `${page.url} redirects to ${result.finalUrl}, downgrading to HTTP.`
      )
    );
  }

  if (!result.encoding) {
    found.push(
      finding(
        "BLUME_AUDIT_NOT_COMPRESSED",
        site,
        `${page.url} is served without gzip or brotli compression.`
      )
    );
  }

  if (result.ms !== undefined && result.ms > SLOW_MS) {
    found.push(
      finding(
        "BLUME_AUDIT_SLOW_RESPONSE",
        site,
        `${page.url} took ${result.ms}ms to respond.`
      )
    );
  }

  // The header wins over the meta tag, so a stray `X-Robots-Tag: noindex` —
  // Vercel sets one on password-protected and preview deploys — silently
  // deindexes a page whose HTML looks perfectly indexable.
  const tag = result.robotsTag;
  if (tag?.includes("noindex") && page.indexable) {
    found.push(
      finding(
        "BLUME_AUDIT_ROBOTS_HEADER_CONFLICT",
        site,
        `${page.url} sends "X-Robots-Tag: ${tag}" but its HTML has no noindex — the header wins.`
      )
    );
  }

  return found;
};

/**
 * The built site, checked against a live deployment.
 *
 * Everything here needs the network, which is why it only runs with `--url`: a
 * page that exists in `dist/` can still 404 in production behind a bad rewrite,
 * and only the real response carries the headers (`Content-Encoding`,
 * `X-Robots-Tag`) that decide whether the page is compressed and indexable.
 */
export const networkChecks: CheckModule = {
  category: "network",
  async run(context) {
    const { origin } = context;
    if (!origin) {
      return [];
    }

    const found: Diagnostic[] = [];
    const targets = context.pages.map((page) => liveUrl(origin, page));
    // robots.txt and sitemap.xml are fetched alongside the pages: they're the
    // two files a crawler asks for first, and a deploy that hides them silently
    // undoes everything else the audit checks.
    const robotsUrl = new URL("/robots.txt", origin).toString();
    const sitemapUrl = new URL("/sitemap.xml", origin).toString();

    const results = await probeAll([...targets, robotsUrl, sitemapUrl]);

    for (const page of context.pages) {
      const result = results.get(liveUrl(origin, page));
      if (!result) {
        continue;
      }
      const failure = badResponse(context, page, result);
      if (failure) {
        found.push(failure);
        continue;
      }
      found.push(...servedPageChecks(context, page, result, origin));
    }

    const robots = results.get(robotsUrl);
    if (robots && !robots.ok) {
      found.push(
        finding(
          "BLUME_AUDIT_ROBOTS_NOT_ACCESSIBLE",
          { url: "/robots.txt" },
          `robots.txt is not reachable at ${robotsUrl}.`
        )
      );
    }

    const sitemap = results.get(sitemapUrl);
    if (context.sitemap && sitemap && !sitemap.ok) {
      found.push(
        finding(
          "BLUME_AUDIT_SITEMAP_NOT_ACCESSIBLE",
          { url: "/sitemap.xml" },
          `sitemap.xml is in the build but is not reachable at ${sitemapUrl}.`
        )
      );
    }

    return found;
  },
  tier: "network",
};

/**
 * Outbound links, probed over the network (`--external`).
 *
 * Severity is graded rather than flat: a 404 is the author's bug, but a 403 or a
 * 5xx is usually rate limiting or someone else's outage, and failing a build on
 * that would make the check useless.
 */
export const externalChecks: CheckModule = {
  category: "network",
  async run(context) {
    const origin = siteOrigin(context.project.config.deployment.site);

    /** Every outbound URL, and the pages that link to it. */
    const linkers = new Map<string, PageSnapshot[]>();
    for (const page of context.pages) {
      for (const link of page.links) {
        const resolved = resolveHref(page.url, link.href, origin);
        if (resolved.kind !== "external") {
          continue;
        }
        const pages = linkers.get(resolved.url);
        if (pages) {
          if (!pages.includes(page)) {
            pages.push(page);
          }
        } else {
          linkers.set(resolved.url, [page]);
        }
      }
    }

    if (linkers.size === 0) {
      return [];
    }
    const results = await probeAll([...linkers.keys()]);

    const found: Diagnostic[] = [];
    for (const [url, pages] of linkers) {
      const result = results.get(url);
      if (!result) {
        continue;
      }
      const site = pageSite(context, pages[0] as PageSnapshot);

      const grade = gradeExternal(result);
      if (grade) {
        // Severity is graded, not flat. A 404 is a bug the author can fix; a 403
        // or 5xx is usually rate limiting or someone else's outage, and failing
        // a build on that would get `--external` switched off for good.
        found.push({
          ...finding(
            "BLUME_AUDIT_EXTERNAL_LINK_BROKEN",
            site,
            `${url} is unreachable (${grade.detail}), linked from ${pages.length} page(s).`
          ),
          severity: grade.severity,
        });
        continue;
      }

      if (result.redirected && result.finalUrl && result.finalUrl !== url) {
        found.push(
          finding(
            "BLUME_AUDIT_EXTERNAL_LINK_REDIRECT",
            site,
            `${url} redirects to ${result.finalUrl}.`
          )
        );
      }
    }
    return found;
  },
  tier: "external",
};
