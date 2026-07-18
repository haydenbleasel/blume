import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { orphanPages } from "../graph.ts";
import { pageSite } from "../locate.ts";
import type {
  AuditContext,
  CheckModule,
  PageSnapshot,
  SnapshotLink,
} from "../types.ts";
import { normalizePath, resolveHref, siteOrigin } from "../url.ts";

/** Whether a path is served by the build — as a page, or as a static file. */
const isServed = (context: AuditContext, path: string): boolean =>
  context.byUrl.has(path) ||
  context.files.has(path) ||
  // Astro's directory format serves `/docs/api` from `/docs/api/index.html`.
  context.files.has(`${path}/index.html`);

/** Browser-magic fragments that scroll without needing a matching id. */
const MAGIC_FRAGMENTS = new Set(["", "top"]);

/** Whether a fragment lands on an id of the target page. */
const anchorResolves = (target: PageSnapshot, fragment: string): boolean => {
  if (MAGIC_FRAGMENTS.has(fragment)) {
    return true;
  }
  // Hrefs usually carry the fragment percent-encoded while the HTML id is not;
  // check both spellings so an encoded match isn't reported as broken.
  try {
    return (
      target.ids.has(fragment) || target.ids.has(decodeURIComponent(fragment))
    );
  } catch {
    return target.ids.has(fragment);
  }
};

const redirectFrom = (context: AuditContext, path: string) =>
  context.redirects.find((entry) => normalizePath(entry.from) === path);

/**
 * Internal links, and what they land on.
 *
 * Broken *chrome* links are deduplicated by target: Blume renders the sidebar on
 * every page, so one bad nav entry would otherwise be reported once per page —
 * hundreds of findings for a single typo. Body links are reported per
 * occurrence, because each one lives in a different `.mdx` a reader can go fix.
 */
export const linkChecks: CheckModule = {
  category: "links",
  run(context) {
    const found: Diagnostic[] = [];
    const origin = siteOrigin(context.project.config.deployment.site);
    /** Broken chrome targets, and the first page each was seen on. */
    const brokenChrome = new Map<string, PageSnapshot>();
    const redirectedChrome = new Map<string, PageSnapshot>();

    /** Broken anchor targets in chrome (`url#frag`), first page each was seen on. */
    const brokenChromeAnchors = new Map<string, PageSnapshot>();

    /**
     * A fragment must land on an id of the page it targets — a miss loads the
     * page but silently dumps the reader at the top, which no crawler reports
     * because the HTTP response is a healthy 200.
     */
    const checkAnchor = (
      page: PageSnapshot,
      link: SnapshotLink,
      target: PageSnapshot,
      fragment: string
    ): void => {
      if (anchorResolves(target, fragment)) {
        return;
      }
      const where =
        target === page ? "this page" : `${target.url}, which has no such id`;
      if (link.content) {
        found.push(
          finding(
            "BLUME_AUDIT_ANCHOR_BROKEN",
            pageSite(context, page),
            `Link to ${link.href} points at #${fragment} on ${where}.`
          )
        );
      } else {
        const key = `${target.url}#${fragment}`;
        if (!brokenChromeAnchors.has(key)) {
          brokenChromeAnchors.set(key, page);
        }
      }
    };

    const classify = (page: PageSnapshot, link: SnapshotLink): void => {
      // Same-page anchors (`#setup`) never leave the page, so resolveHref
      // files them under "ignored" — but their fragment still has to exist.
      if (link.href.startsWith("#")) {
        checkAnchor(page, link, page, link.href.slice(1));
        return;
      }

      const resolved = resolveHref(page.url, link.href, origin);
      if (resolved.kind === "external" || resolved.kind === "ignored") {
        return;
      }

      const anchorTarget = resolved.hash
        ? context.byUrl.get(resolved.path)
        : undefined;
      if (anchorTarget) {
        checkAnchor(page, link, anchorTarget, resolved.hash);
      }

      if (resolved.kind === "self-origin") {
        found.push(
          finding(
            "BLUME_AUDIT_INTERNAL_LINK_ABSOLUTE",
            pageSite(context, page),
            `Link to ${link.href} hardcodes the site's origin; use ${resolved.path} instead.`
          )
        );
      }

      if (link.rel?.includes("nofollow")) {
        found.push(
          finding(
            "BLUME_AUDIT_INTERNAL_LINK_NOFOLLOW",
            pageSite(context, page),
            `Internal link to ${resolved.path} is rel="nofollow".`
          )
        );
      }

      const { path } = resolved;
      const redirect = redirectFrom(context, path);
      if (redirect) {
        if (link.content) {
          found.push(
            finding(
              "BLUME_AUDIT_LINK_TO_REDIRECT",
              pageSite(context, page),
              `Link to ${path} goes through a redirect to ${redirect.to}.`
            )
          );
        } else if (!redirectedChrome.has(path)) {
          redirectedChrome.set(path, page);
        }
        return;
      }

      if (isServed(context, path)) {
        return;
      }

      if (link.content) {
        found.push(
          finding(
            "BLUME_AUDIT_LINK_TO_BROKEN",
            pageSite(context, page),
            `Link to ${link.href} resolves to ${path}, which the build does not serve.`
          )
        );
      } else if (!brokenChrome.has(path)) {
        brokenChrome.set(path, page);
      }
    };

    for (const page of context.pages) {
      for (const link of page.links) {
        classify(page, link);
      }
    }

    for (const [path, page] of brokenChrome) {
      found.push(
        finding(
          "BLUME_AUDIT_LINK_TO_BROKEN",
          { url: page.url },
          `Navigation links to ${path}, which the build does not serve.`,
          "Fix the entry in your navigation config or meta file."
        )
      );
    }
    for (const [path, page] of redirectedChrome) {
      const redirect = redirectFrom(context, path);
      found.push(
        finding(
          "BLUME_AUDIT_LINK_TO_REDIRECT",
          { url: page.url },
          `Navigation links to ${path}, which redirects to ${redirect?.to}.`,
          "Point the navigation entry straight at the destination."
        )
      );
    }
    for (const [key, page] of brokenChromeAnchors) {
      found.push(
        finding(
          "BLUME_AUDIT_ANCHOR_BROKEN",
          { url: page.url },
          `Navigation links to ${key}, but the target page has no such id.`
        )
      );
    }

    for (const page of orphanPages(context.pages, context.graph)) {
      found.push(
        finding(
          "BLUME_AUDIT_ORPHAN_PAGE",
          pageSite(context, page),
          "No other page's body links here — it is reachable only from the sidebar."
        )
      );
    }

    return found;
  },
  tier: "static",
};
