import { extname, relative } from "pathe";
import { glob, globSync } from "tinyglobby";

import type { BlumeProject } from "../core/project-graph.ts";
import type { BlumePageRoute } from "./integration.ts";

const PAGE_GLOB = ["**/*.astro"];

/**
 * Astro's routing convention: a file or folder whose name starts with `_` is a
 * private partial — importable (shared layouts, home-page sections), but never
 * built into a route. Blume injects pages itself, so it must reproduce the same
 * exclusion or every `pages/_home/Hero.astro`-style component ships as an HTML
 * page.
 */
const isPrivatePage = (rel: string): boolean =>
  rel.split("/").some((segment) => segment.startsWith("_"));

/** Map discovered page files to routes; shared by the async/sync discoverers. */
const toPageRoutes = (pagesRoot: string, files: string[]): BlumePageRoute[] => {
  files.sort();
  const routes: BlumePageRoute[] = [];
  for (const file of files) {
    const rel = relative(pagesRoot, file);
    if (isPrivatePage(rel)) {
      continue;
    }
    const withoutExt = rel.slice(0, rel.length - extname(rel).length);
    const parts = withoutExt.split("/");
    // Only a trailing `index` maps to its parent dir; a folder literally named
    // `index` (e.g. `index/foo.astro`) must keep its segment.
    if (parts.at(-1) === "index") {
      parts.pop();
    }
    const pattern = parts.length === 0 ? "/" : `/${parts.join("/")}`;
    routes.push({ entrypoint: file, pattern });
  }
  return routes;
};

/**
 * Discover user `.astro` pages and map them to route patterns. Files keep their
 * original location; only the route pattern is derived (index -> parent,
 * dynamic `[param]` segments preserved).
 */
export const discoverPages = async (
  pagesRoot: string
): Promise<BlumePageRoute[]> =>
  toPageRoutes(
    pagesRoot,
    await glob(PAGE_GLOB, { absolute: true, cwd: pagesRoot, onlyFiles: true })
  );

/** {@link discoverPages} for synchronous callers (e.g. the sitemap builder). */
export const discoverPagesSync = (pagesRoot: string): BlumePageRoute[] =>
  toPageRoutes(
    pagesRoot,
    globSync(PAGE_GLOB, { absolute: true, cwd: pagesRoot, onlyFiles: true })
  );

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

/** Skip private (`_partial`, `.well-known`) and Astro dynamic (`[param]`) parts. */
const PRIVATE_SEGMENT = /^[._]/u;

/** Segments of a static, shareable page pattern; null for dynamic/private ones. */
const staticSegments = (pattern: string): string[] | null => {
  const segments = pattern.split("/").filter(Boolean);
  return segments.some(
    (part) => PRIVATE_SEGMENT.test(part) || part.includes("[")
  )
    ? null
    : segments;
};

/**
 * The static routes served by custom `.astro` pages — the same filtering as
 * {@link customOgRoutes}, but yielding the routes themselves. Feeds the route
 * sets that must know every servable page beyond the content graph (the link
 * checker, the sitemap); dynamic (`[param]`) and private segments are skipped
 * because their concrete URLs can't be enumerated statically.
 */
export const customStaticRoutes = (pages: { pattern: string }[]): string[] => {
  const routes = new Set<string>();
  for (const { pattern } of pages) {
    const segments = staticSegments(pattern);
    if (segments !== null) {
      routes.add(segments.length === 0 ? "/" : `/${segments.join("/")}`);
    }
  }
  return [...routes];
};

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
): boolean => {
  const hasChangelog = project.graph.pages.some(
    (page) =>
      page.contentType === "changelog" &&
      !(page.meta.draft || page.meta.sidebar.hidden)
  );
  const hasChangelogSource = (project.config.content.sources ?? []).some(
    (source) => source.type === "github-releases"
  );
  return (
    (hasChangelog || hasChangelogSource) &&
    !routeIsTaken(userPages, project.graph.pages, "/changelog")
  );
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
 * are skipped: they aren't shareable pages. The home is titled with the site
 * title; a deeper page is titled from its last path segment. The card's brand
 * lockup, description, and footer come from the resolved config at render time.
 */
export const customOgRoutes = (
  pages: BlumePageRoute[],
  siteTitle: string
): OgCustomRoute[] => {
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
    routes.push({ slug, title: last ? humanizeSegment(last) : siteTitle });
  };
  for (const { pattern } of pages) {
    collectRoute(pattern);
  }
  return routes;
};
