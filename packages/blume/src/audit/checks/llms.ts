import { normalizeBasePath, stripBasePath } from "../../core/base-path.ts";
import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import { ERROR_ROUTES } from "../types.ts";
import type { AuditContext, CheckModule } from "../types.ts";
import { normalizePath, siteOrigin } from "../url.ts";

/** The `ai.llmsTxt` config normalized to what the checks need. */
const llmsConfig = (
  context: AuditContext
): { enabled: boolean; openapi: boolean } => {
  const value = context.project.config.ai?.llmsTxt;
  if (typeof value === "object" && value !== null) {
    return { enabled: value.enabled, openapi: value.openapi };
  }
  return { enabled: value !== false, openapi: true };
};

/**
 * An llms.txt link target reduced to a site path, or null when it's off-site.
 * Entry URLs carry the deployment base; page URLs (from the file tree) don't.
 */
const entryPath = (
  url: string,
  origin: string | null,
  deployBase: string
): string | null => {
  if (/^https?:\/\//iu.test(url)) {
    try {
      const parsed = new URL(url);
      if (origin && parsed.origin !== origin) {
        return null;
      }
      return normalizePath(
        stripBasePath(deployBase, decodeURI(parsed.pathname))
      );
    } catch {
      return null;
    }
  }
  if (!url.startsWith("/")) {
    return null;
  }
  try {
    return normalizePath(stripBasePath(deployBase, decodeURI(url)));
  } catch {
    return normalizePath(stripBasePath(deployBase, url));
  }
};

/**
 * The `llms.txt` index, held to the sitemap's standard.
 *
 * SEO crawlers audit for Google and stop there. But Blume's promise is
 * AI-ready docs, and `llms.txt` is the sitemap of that surface: a stale entry
 * sends an agent to a page that is not there, and an unlisted page is
 * invisible to every tool that starts from the index.
 */
export const llmsChecks: CheckModule = {
  category: "ai",
  run(context) {
    const { enabled, openapi } = llmsConfig(context);
    if (!enabled) {
      return [];
    }

    const { llms } = context;
    if (!llms) {
      return [
        finding(
          "BLUME_AUDIT_LLMS_TXT_MISSING",
          { url: "/llms.txt" },
          "The build has no llms.txt."
        ),
      ];
    }

    const found: Diagnostic[] = [];
    const origin = siteOrigin(context.project.config.deployment.site);
    const deployBase = normalizeBasePath(
      context.project.config.deployment.base
    );

    const listed = new Set<string>();
    for (const entry of llms.entries) {
      const path = entryPath(entry.url, origin, deployBase);
      if (path === null) {
        // Off-site or unparseable targets aren't pages this build can vouch
        // for; external link health is the `--external` tier's job.
        continue;
      }
      listed.add(path);
      // A listed target may be a served asset rather than a page — Blume's own
      // llms.txt links the changelog RSS feed — so the file index vouches for
      // it too, the same way redirect targets may land on a served asset.
      if (!context.byUrl.has(path) && !context.files.has(path)) {
        found.push(
          finding(
            "BLUME_AUDIT_LLMS_TXT_STALE_ENTRY",
            { file: llms.file, line: entry.line, url: entry.url },
            `llms.txt lists ${path}, which the build does not serve.`
          )
        );
      }
    }

    // The reverse direction, mirroring INDEXABLE_PAGE_NOT_IN_SITEMAP: a page
    // that is built, indexable, and in the nav belongs in the index. Pages the
    // generator deliberately skips — hidden, drafts, error routes, API
    // reference when `ai.llmsTxt.openapi` is off, custom pages with no
    // manifest route — are skipped here for the same reasons.
    for (const page of context.pages) {
      const { route } = page;
      if (
        !route ||
        route.hidden ||
        route.draft ||
        !page.indexable ||
        ERROR_ROUTES.has(page.url) ||
        (!openapi && route.source.name === "openapi") ||
        listed.has(normalizePath(page.url))
      ) {
        continue;
      }
      found.push(
        finding(
          "BLUME_AUDIT_LLMS_TXT_PAGE_MISSING",
          pageSite(context, page),
          `${page.url} is built and indexable but is not listed in llms.txt.`
        )
      );
    }

    return found;
  },
  tier: "static",
};
