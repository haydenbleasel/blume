import { normalizeBasePath, stripBasePath } from "../../core/base-path.ts";
import { gradeExternal, probeAll } from "../../core/probe.ts";
import type { ProbeResult } from "../../core/probe.ts";
import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type {
  AuditContext,
  CheckModule,
  PageSnapshot,
  RedirectResolution,
} from "../types.ts";
import { decodePath, normalizePath, resolveHref, siteOrigin } from "../url.ts";

const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;
/** Past this, a page is slow enough that it costs you crawl budget and readers. */
const SLOW_MS = 1500;

/**
 * The live URL a built page is served at, under the `--url` origin. Page URLs
 * come from the built file tree and carry no `deployment.base`, but the live
 * site serves everything under it — probing without the base would 4xx every
 * page of a healthy subpath deployment.
 */
const liveUrl = (
  origin: string,
  page: PageSnapshot,
  deployBase: string
): string => new URL(`${deployBase}${page.url}`, origin).toString();

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
 * The configured redirects the live site should answer: only those the static
 * checks passed. A pattern (`/beta/:slug*`) names no single URL to request, a
 * loop never lands, and a redirect whose source is also a page never fires.
 */
const liveRedirects = (context: AuditContext): RedirectResolution[] =>
  context.redirects.filter(
    (redirect) =>
      (redirect.outcome === "ok" || redirect.outcome === "chain") &&
      !context.byUrl.has(normalizePath(redirect.from))
  );

/**
 * What requesting a redirect's old URL on the live site got wrong, or null
 * when it redirected to the configured destination.
 *
 * The build writes the host's redirect file, but a host that doesn't read it
 * answers with the meta-refresh page Astro writes at the old URL (a 200:
 * readers still get there, so it's a warning), and a missing redirect 404s (an
 * error). An external destination isn't compared: its site may redirect again.
 */
export const liveRedirectCheck = (
  context: AuditContext,
  redirect: RedirectResolution,
  result: ProbeResult,
  deployBase: string
): Diagnostic | null => {
  const from = normalizePath(redirect.from);
  const site = {
    file: context.project.context.configFile ?? undefined,
    url: from,
  };
  const landed =
    result.redirected && result.finalUrl
      ? normalizePath(
          stripBasePath(
            deployBase,
            decodePath(new URL(result.finalUrl).pathname)
          )
        )
      : from;

  // A host that only adds a trailing slash (`/old` → `/old/`) still didn't
  // redirect to the destination.
  if (landed === from) {
    let answer = `could not be reached (${result.error ?? "no response"})`;
    if (result.timedOut) {
      answer = "did not respond in time";
    } else if (result.status !== undefined) {
      answer = `answered it with HTTP ${result.status} instead`;
    }
    const found = finding(
      "BLUME_AUDIT_REDIRECT_NOT_SERVED",
      site,
      `${from} should redirect to ${redirect.to}, but the live site ${answer}.`
    );
    return result.ok ? { ...found, severity: "warning" } : found;
  }

  const destination = redirect.chain.at(-1) ?? from;
  if (/^https?:\/\//iu.test(destination) || landed === destination) {
    return null;
  }
  return {
    ...finding(
      "BLUME_AUDIT_REDIRECT_NOT_SERVED",
      site,
      `${from} redirects to ${landed} on the live site, not to ${destination}.`
    ),
    severity: "warning",
  };
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
    const deployBase = normalizeBasePath(
      context.project.config.deployment.options.base
    );
    const targets = context.pages.map((page) =>
      liveUrl(origin, page, deployBase)
    );
    // robots.txt and sitemap.xml are fetched alongside the pages: they're the
    // two files a crawler asks for first, and a deploy that hides them silently
    // undoes everything else the audit checks. They sit at the root of the
    // build output, which the host serves under the deployment base.
    const robotsUrl = new URL(`${deployBase}/robots.txt`, origin).toString();
    const sitemapUrl = new URL(`${deployBase}/sitemap.xml`, origin).toString();
    // Each configured redirect is requested at its old URL, the way a reader
    // following an old link arrives. Its `from` carries `basePath`; the host
    // serves it under the deployment base too.
    const redirects = liveRedirects(context).map(
      (redirect) =>
        [
          redirect,
          new URL(`${deployBase}${redirect.from}`, origin).toString(),
        ] as const
    );

    const results = await probeAll([
      ...targets,
      robotsUrl,
      sitemapUrl,
      ...redirects.map(([, url]) => url),
    ]);

    for (const page of context.pages) {
      const result = results.get(liveUrl(origin, page, deployBase));
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

    for (const [redirect, url] of redirects) {
      // SAFETY: every redirect URL was in the probed list, and `probeAll`
      // returns a result for each URL it was given.
      const result = results.get(url) as ProbeResult;
      const wrong = liveRedirectCheck(context, redirect, result, deployBase);
      if (wrong) {
        found.push(wrong);
      }
    }

    // With `seo.robots: false` Blume writes no robots.txt, so its absence on
    // the live site is the configured outcome, not a defect.
    const robots = results.get(robotsUrl);
    if (context.project.config.seo.robots && robots && !robots.ok) {
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
 * Outbound links, probed over the network (`--external`), except those an
 * `--ignore` glob matches.
 *
 * Severity is graded rather than flat: a 404 is the author's bug, but a 403 or a
 * 5xx is usually rate limiting or someone else's outage, and failing a build on
 * that would make the check useless.
 */
export const externalChecks: CheckModule = {
  category: "network",
  async run(context) {
    const origin = siteOrigin(context.project.config.deployment.options.site);
    const deployBase = normalizeBasePath(
      context.project.config.deployment.options.base
    );

    /** Every outbound URL, and the pages that link to it. */
    const linkers = new Map<string, PageSnapshot[]>();
    for (const page of context.pages) {
      for (const link of page.links) {
        const resolved = resolveHref(page.url, link.href, origin, deployBase);
        if (resolved.kind !== "external" || context.ignore(resolved.url)) {
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
      // SAFETY: every `linkers` entry is created with its linking page and only
      // ever appended to, so the array is never empty.
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
