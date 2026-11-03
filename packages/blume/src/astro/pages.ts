import { BLOG_INDEX_ROUTE, blogTagRoutes, hasBlogIndex } from "../core/blog.ts";
import {
  CHANGELOG_INDEX_ROUTE,
  hasChangelogIndex,
} from "../core/changelog-index.ts";
import { staticSegments } from "../core/custom-pages.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { redirectCovers } from "../core/redirect-patterns.ts";
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

/** A whole-segment rest parameter (`[...slug]`), which takes the rest. */
const REST_PARAM = /^\[\.\.\..+\]$/u;

/** A `[param]` within a pattern segment. */
const PARAM = /\[[^\]]+\]/u;

/**
 * Whether one pattern segment answers one route segment: its literal text as
 * written, each `[param]` standing for one or more characters, so
 * `post-[id]` answers `post-1` but not `blog`.
 */
const segmentAnswers = (part: string, segment: string): boolean => {
  const literal = part
    .split(PARAM)
    .map((text) => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`));
  return new RegExp(`^${literal.join(".+")}$`, "u").test(segment);
};

/**
 * Whether a custom page's `pattern` answers `route` as Astro routes it:
 * segment by segment (see {@link segmentAnswers}), where a `[...rest]`
 * segment answers everything after it, nothing included. The route's first
 * `fixed` segments are static in Blume's own pattern (`blog`, `tags`), which
 * Astro ranks above a parameter, so only the same literal (or a rest) there
 * answers them: `blog/[category]/[slug]` leaves `/blog/tags/<tag>` to Blume.
 */
const patternAnswers = (
  pattern: string,
  route: string,
  fixed: number
): boolean => {
  const parts = pattern.split("/").filter(Boolean);
  const segments = route.split("/").filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (REST_PARAM.test(part)) {
      return true;
    }
    const segment = segments[index];
    const answers =
      index < fixed ? part === segment : segmentAnswers(part, segment ?? "");
    if (segment === undefined || !answers) {
      return false;
    }
  }
  return parts.length === segments.length;
};

/** Whether a custom page's `pattern` lives under `pages/blog/`. */
const isUnderBlog = (pattern: string): boolean =>
  pattern.split("/").find(Boolean) === "blog";

/**
 * Whether a generated blog route is someone else's: content, a user page —
 * a dynamic one under `pages/blog/` too (`blog/tags/[tag].astro`), the
 * site's own blog pages, though not a site-wide `[...slug].astro`, which
 * rarely serves the blog — or a configured redirect (a site whose posts live
 * elsewhere may redirect `/blog/:slug*` there) already answers it.
 */
const blogRouteIsTaken = (
  project: BlumeProject,
  userPages: { pattern: string }[],
  route: string
): boolean =>
  routeIsTaken(userPages, project.graph.pages, route) ||
  userPages.some(
    (page) =>
      isUnderBlog(page.pattern) &&
      // Every segment but a tag page's slug is Blume's own.
      patternAnswers(page.pattern, route, route === BLOG_INDEX_ROUTE ? 1 : 2)
  ) ||
  redirectCovers(project.config.redirects, project.config.basePath, route);

/**
 * Whether the generated `/blog` index route exists for this project: there
 * are visible `type: blog` posts and no user content, custom page, or
 * redirect already owns `/blog`. Shared, like {@link hasGeneratedChangelog},
 * by the page write and every surface that lists served routes.
 */
export const hasGeneratedBlog = (
  project: BlumeProject,
  userPages: { pattern: string }[]
): boolean =>
  hasBlogIndex(
    project.graph.pages,
    project.config.i18n?.defaultLocale ?? null
  ) && !blogRouteIsTaken(project, userPages, BLOG_INDEX_ROUTE);

/**
 * The generated tag pages' routes (`/blog/tags/<slug>`), one per tag the
 * index lists, beside a generated `/blog` index — less any route a user page
 * or a redirect already owns, which keeps it.
 */
export const generatedBlogTagRoutes = (
  project: BlumeProject,
  userPages: { pattern: string }[]
): string[] =>
  blogTagRoutes(
    project.graph.pages,
    project.config.i18n?.defaultLocale ?? null
  ).filter((route) => !blogRouteIsTaken(project, userPages, route));

/**
 * Every route a navigation entry (a tab, selector item, featured link, header
 * action, or CTA) may point at: content routes, custom `.astro` pages, the
 * generated changelog and blog, and reference routes (so a tab an author
 * points at one still validates). `generateRuntime` and `blume doctor` both
 * check `validateNavTargets` against it, so they flag the same entries.
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
  if (hasGeneratedBlog(project, userPages)) {
    routes.add(BLOG_INDEX_ROUTE);
  }
  for (const route of generatedBlogTagRoutes(project, userPages)) {
    routes.add(route);
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
