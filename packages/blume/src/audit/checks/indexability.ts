import { SITE_INFERRING_ADAPTERS } from "../../core/deployment-env.ts";
import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import { ERROR_ROUTES } from "../types.ts";
import type { AuditContext, CheckModule, PageSnapshot } from "../types.ts";
import { normalizePath, siteOrigin } from "../url.ts";

/** The canonical URL parsed, or null when it isn't a usable absolute URL. */
const parseCanonical = (page: PageSnapshot): URL | null => {
  if (!page.canonical) {
    return null;
  }
  try {
    return new URL(page.canonical);
  } catch {
    return null;
  }
};

const canonicalChecks = (
  context: AuditContext,
  page: PageSnapshot
): Diagnostic[] => {
  const { site } = context.project.config.deployment;
  const origin = siteOrigin(site);

  // Error routes are noindex by design, so a canonical on them is meaningless
  // and its absence isn't a defect — flagging /404 would be a guaranteed
  // finding on every site that has an error page.
  if (ERROR_ROUTES.has(page.url)) {
    return [];
  }

  if (!page.canonical) {
    // Without `deployment.site` Blume has no absolute URL to canonicalize to, so
    // report the root cause once (in the sitemap/robots checks) rather than
    // flagging every page for a config field they can't fix individually.
    return site
      ? [
          finding(
            "BLUME_AUDIT_CANONICAL_MISSING",
            pageSite(context, page),
            "Page has no canonical URL."
          ),
        ]
      : [];
  }

  const canonical = parseCanonical(page);
  if (!canonical) {
    return [
      finding(
        "BLUME_AUDIT_CANONICAL_BAD_TARGET",
        pageSite(context, page, ["seo", "canonical"]),
        `Canonical "${page.canonical}" is not a valid absolute URL.`
      ),
    ];
  }

  const found: Diagnostic[] = [];
  if (origin && canonical.origin !== origin) {
    const sameHost = canonical.host === new URL(origin).host;
    // A different *protocol* on the same host is a misconfiguration worth
    // calling out; a different host entirely is a deliberate cross-site
    // canonical, which is legitimate.
    if (sameHost) {
      found.push(
        finding(
          "BLUME_AUDIT_CANONICAL_PROTOCOL_MISMATCH",
          pageSite(context, page, ["seo", "canonical"]),
          `Canonical uses ${canonical.protocol}// but the site is ${new URL(origin).protocol}//.`
        )
      );
    }
    return found;
  }

  const target = normalizePath(canonical.pathname);
  if (target === normalizePath(page.url)) {
    return found;
  }

  // The canonical points at another page on this site. It must exist, and it
  // must not itself redirect — a canonical to a redirect is a dead end.
  const redirect = context.redirects.find(
    (entry) => normalizePath(entry.from) === target
  );
  if (redirect) {
    found.push(
      finding(
        "BLUME_AUDIT_CANONICAL_BAD_TARGET",
        pageSite(context, page, ["seo", "canonical"]),
        `Canonical points at ${target}, which is a redirect to ${redirect.to}.`
      )
    );
  } else if (context.byUrl.has(target)) {
    found.push(
      finding(
        "BLUME_AUDIT_CANONICAL_NOT_SELF",
        pageSite(context, page, ["seo", "canonical"]),
        `Page declares ${target} as its canonical, so it will not be indexed itself.`
      )
    );
  } else {
    found.push(
      finding(
        "BLUME_AUDIT_CANONICAL_BAD_TARGET",
        pageSite(context, page, ["seo", "canonical"]),
        `Canonical points at ${target}, which is not a page on this site.`
      )
    );
  }
  return found;
};

/**
 * Whether and how a page can be indexed: its canonical, its robots meta, and
 * whether Googlebot will read all of it.
 */
export const indexabilityChecks: CheckModule = {
  category: "indexability",
  run(context) {
    const found: Diagnostic[] = [];

    // Without `deployment.site` Blume has no absolute URL to build from, so it
    // cannot emit a canonical, an Open Graph image, or a sitemap on *any* page.
    // That's one fact about the config, not a defect on each of 200 pages —
    // report it once, and let the checks that depend on it stay quiet.
    if (!context.project.config.deployment.site) {
      const { adapter } = context.project.config.deployment;
      const site = {
        file: context.project.context.configFile ?? undefined,
        url: "/",
      };
      // On a platform adapter the value arrives from the platform's env vars
      // at deploy time (`applyDeploymentEnv`), so only this local artifact is
      // missing it — the deployed site won't be. Hardcoding `deployment.site`
      // would duplicate state the platform owns, so the finding (which agents
      // apply verbatim via `--claude`/`--codex`) must not suggest it.
      found.push(
        adapter && SITE_INFERRING_ADAPTERS.has(adapter)
          ? finding(
              "BLUME_AUDIT_SITE_INFERRED_AT_DEPLOY",
              site,
              `deployment.site is not set in this build — on ${adapter} it is inferred from the platform env at deploy time, so canonical URLs, Open Graph images, and the sitemap are only missing from this local artifact.`
            )
          : finding(
              "BLUME_AUDIT_SITE_NOT_SET",
              site,
              "deployment.site is not set, so no canonical URLs, Open Graph images, or sitemap can be generated."
            )
      );
    }

    for (const page of context.pages) {
      found.push(...canonicalChecks(context, page));

      // Error routes are *meant* to carry noindex, so reporting them would be a
      // guaranteed finding on every site that has a 404 page.
      if (page.robots && !ERROR_ROUTES.has(page.url)) {
        found.push(
          finding(
            "BLUME_AUDIT_ROBOTS_META_UNEXPECTED",
            pageSite(context, page, ["noindex"]),
            `Page declares robots "${page.robots}" and will not be indexed.`
          )
        );

        // Google warns against pairing the two: the canonical says "index that
        // URL", the robots meta says "don't trust this page's signals" — and
        // which one wins is undefined.
        if (!page.indexable && page.canonical) {
          found.push(
            finding(
              "BLUME_AUDIT_CANONICAL_ON_NOINDEX",
              pageSite(context, page, ["noindex"]),
              `Page is noindex but declares ${page.canonical} as its canonical.`
            )
          );
        }
      }

      // Only the manifest knows a page was a draft — the built HTML looks like
      // any other page, which is exactly why deploying a `--preview` build is
      // so easy to miss.
      if (page.route?.draft) {
        found.push(
          finding(
            "BLUME_AUDIT_DRAFT_PAGE_PUBLISHED",
            pageSite(context, page, ["draft"]),
            `${page.url} is marked draft in its front matter but is in the build.`
          )
        );
      }

      if (page.bytes > context.thresholds.maxHtmlBytes) {
        const mb = (page.bytes / 1024 / 1024).toFixed(1);
        found.push(
          finding(
            "BLUME_AUDIT_HTML_TOO_LARGE",
            pageSite(context, page),
            `Page HTML is ${mb} MB — past Googlebot's 2 MB limit, the rest is not crawled.`
          )
        );
      }
    }
    return found;
  },
  tier: "static",
};
