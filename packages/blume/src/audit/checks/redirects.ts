import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type { CheckModule } from "../types.ts";
import { normalizePath } from "../url.ts";

/**
 * Configured redirects, walked through to their destinations.
 *
 * Ahrefs also lists "3XX redirect" and "302 redirect" as issues. Having a
 * redirect is inventory, not a defect, and "HTTP to HTTPS redirect" — which it
 * also flags — is correct behavior. None of those are reported. What is: a
 * redirect that loops, dead-ends, takes the long way round, or is shadowed by a
 * real page and therefore never fires at all.
 */
export const redirectChecks: CheckModule = {
  category: "redirects",
  run(context) {
    const found: Diagnostic[] = [];
    const configFile = context.project.context.configFile ?? undefined;
    const site = { file: configFile, url: "/" };

    for (const redirect of context.redirects) {
      const from = normalizePath(redirect.from);

      // A redirect whose source is also a built page never fires — the page
      // wins. Ahrefs can't see this: it only observes the served response, which
      // looks perfectly healthy.
      if (context.byUrl.has(from)) {
        found.push(
          finding(
            "BLUME_AUDIT_REDIRECT_SOURCE_IS_PAGE",
            { ...site, url: from },
            `A redirect is configured from ${from}, but ${from} is also a real page — the redirect never fires.`
          )
        );
        continue;
      }

      if (redirect.outcome === "loop") {
        found.push(
          finding(
            "BLUME_AUDIT_REDIRECT_LOOP",
            { ...site, url: from },
            `Redirect loop: ${redirect.chain.join(" → ")}`
          )
        );
      } else if (redirect.outcome === "broken") {
        found.push(
          finding(
            "BLUME_AUDIT_REDIRECT_BROKEN",
            { ...site, url: from },
            `Redirect from ${from} lands on ${redirect.chain.at(-1)}, which the build does not serve.`
          )
        );
      } else if (redirect.outcome === "chain") {
        const hops = redirect.chain.length - 1;
        const severity =
          hops > context.thresholds.maxRedirectHops ? " (too long)" : "";
        found.push(
          finding(
            "BLUME_AUDIT_REDIRECT_CHAIN",
            { ...site, url: from },
            `Redirect from ${from} passes through ${hops} hops${severity}: ${redirect.chain.join(" → ")}`
          )
        );
      }
    }

    // A meta refresh is a redirect the framework doesn't know about, so it can't
    // be validated, cached, or followed reliably by crawlers.
    for (const page of context.pages) {
      if (page.metaRefresh) {
        found.push(
          finding(
            "BLUME_AUDIT_META_REFRESH",
            pageSite(context, page),
            `Page uses a meta refresh redirect ("${page.metaRefresh}").`
          )
        );
      }
    }

    return found;
  },
  tier: "static",
};
