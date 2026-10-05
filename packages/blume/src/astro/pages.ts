import {
  CHANGELOG_INDEX_ROUTE,
  hasChangelogIndex,
} from "../core/changelog-index.ts";
import { staticSegments } from "../core/custom-pages.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { referenceRoutes } from "../openapi/references.ts";
import type { BlumePageRoute } from "./integration.ts";

export {
  customStaticRoutes,
  discoverPages,
  discoverPagesSync,
} from "../core/custom-pages.ts";

/**
 * Whether the project already owns `route` — through a custom `.astro` page
 * (injected, so matched on `pattern`) or a content page (matched on `route`).
 * Used to skip a generated default page (e.g. `/404`, `/changelog`) so a
 * user-authored page overrides it without a route collision.
 */
export const routeIsTaken = (
  pages: { pattern: string }[],
  contentPages: { route: string }[],
  route: string
): boolean =>
  pages.some((page) => page.pattern === route) ||
  contentPages.some((page) => page.route === route);

/** A custom-page route that should get a generated OG card. */
export interface OgCustomRoute {
  /** `og/<slug>.png` path segment; `index` for the site root. */
  slug: string;
  /** Card headline. */
  title: string;
}

/**
 * Whether the generated `/changelog` index route exists for this project —
 * `generate.ts` (which writes the page) and the sitemap/link validator all
 * share this check: there are visible `type: changelog` entries — or a
 * release-backed changelog source, whose route must resolve even when a fetch
 * fails — and no user content or custom page already owns `/changelog`.
 */
export const hasGeneratedChangelog = (
  project: BlumeProject,
  userPages: { pattern: string }[]
): boolean =>
  hasChangelogIndex(project.graph.pages, project.config) &&
  !routeIsTaken(userPages, project.graph.pages, CHANGELOG_INDEX_ROUTE);

/**
 * Every route a navigation entry (a tab, selector item, featured link, header
 * action, or CTA) may point at: content routes, custom `.astro` pages, the
 * generated changelog, and reference routes (so a tab an author points at one
 * still validates). `generateRuntime` and `blume doctor` both check
 * `validateNavTargets` against it, so they flag the same entries.
 */
export const navTargetRoutes = (
  project: BlumeProject,
  userPages: { pattern: string }[]
): Set<string> => {
  const routes = new Set<string>([
    ...project.graph.routes.keys(),
    ...userPages.map((page) => page.pattern),
    ...referenceRoutes(project.config),
  ]);
  if (hasGeneratedChangelog(project, userPages)) {
    routes.add(CHANGELOG_INDEX_ROUTE);
  }
  return routes;
};

const humanizeSegment = (segment: string): string =>
  segment
    .split(/[-_]/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/**
 * Pick the custom-page routes that should get a generated Open Graph card, with
 * the card's slug and text. OG is otherwise content-route only, so a custom page
 * — most importantly the landing `/`, the most-shared URL — would have no card.
 *
 * Dynamic (`[param]`) routes and private segments (`_partials`, `.well-known`)
 * are skipped: they aren't shareable pages. A `titles` entry (`seo.og.titles`,
 * keyed by route) names a card outright — the only way to say "CLI" when the
 * segment humanizes to "Cli". Otherwise the home is titled with the site title
 * and a deeper page from its last path segment. The card's brand lockup,
 * description, and footer come from the resolved config at render time.
 */
export const customOgRoutes = (
  pages: BlumePageRoute[],
  siteTitle: string,
  titles: Record<string, string> = {}
): OgCustomRoute[] => {
  // Keys normalized to `/`-joined segments so `cli`, `/cli`, and `/cli/` all
  // address the page served at `/cli` (and `/` addresses the home).
  const overrides = new Map(
    Object.entries(titles).map(([route, title]) => [
      `/${route.split("/").filter(Boolean).join("/")}`,
      title,
    ])
  );
  const seen = new Set<string>();
  const routes: OgCustomRoute[] = [];
  // Extracted so the skip paths become early `return`s (one `continue` budget
  // per loop under the lint rule) instead of `continue` statements.
  const collectRoute = (pattern: string): void => {
    const segments = staticSegments(pattern);
    if (segments === null) {
      return;
    }
    const slug = segments.length === 0 ? "index" : segments.join("/");
    if (seen.has(slug)) {
      return;
    }
    seen.add(slug);
    const last = segments.at(-1);
    routes.push({
      slug,
      title:
        overrides.get(`/${segments.join("/")}`) ??
        (last ? humanizeSegment(last) : siteTitle),
    });
  };
  for (const { pattern } of pages) {
    collectRoute(pattern);
  }
  return routes;
};
