import { basename } from "pathe";

import {
  isInternalPath,
  mountBasePath,
  normalizeBasePath,
  withAuthoredBasePath,
  withBasePath,
} from "../core/base-path.ts";
import { localePrefix } from "../core/i18n.ts";
import {
  buildFileRouteIndex,
  isIndexFileName,
  resolveRawRelativeHref,
  resolveRelativeHref,
  resolveRootFileHref,
  routeOfLinkedEntry,
  routeOfLinkedFile,
} from "../core/links.ts";
import type { FileRouteIndex, RelativeLinkBase } from "../core/links.ts";
import { localizeHref, servesRoute } from "../core/locale-links.ts";
import type { LocalizeHrefOptions } from "../core/locale-links.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { resolveDocsCollection } from "../core/sources/collection.ts";
import { extractLinks } from "../core/sources/normalize.ts";

/**
 * Page links on the agent surfaces — the `.md`/`.mdx` mirrors,
 * llms-full.txt, MCP `get_page` and `resources/read`. An agent resolves
 * `[Install](./install)` against the URL it fetched (`/guides.md`), so the
 * link lands on `/install`; the rendered page rewrites it to the route it
 * means (`markdown/relative-links.ts`), and the Markdown an agent reads gets
 * the same rewrite from the same resolver (`resolveRelativeHref`), so both
 * point at one page. A raw HTML `<a href>` ships as written, so a relative
 * one lands where the browser takes it from the page's URL
 * (`resolveRawRelativeHref`). Root-relative links (`[x](/guide)`,
 * `<Card href="/guide">`, `![logo](/logo.png)`) get what the rendered page
 * gives them too (`markdown/base-links.ts`,
 * `components/content/base-href.ts`): a page link the `deployment.base` +
 * `basePath` prefix, a public file (`/spec.pdf`) or image the
 * `deployment.base` alone, and, on a page in a prefixed locale, a page link
 * that locale's copy of the route when it is served
 * (`components/layout/LocaleLinks.astro`). A root-relative link to a content
 * file (`/guide/new.md`) lands on that file's page, as on the rendered page
 * (`resolveRootFileHref`). Inline links, images, component
 * `href`s, and reference definitions are rewritten; fenced and inline code,
 * relative images and asset links, and external URLs are left as written.
 * The assistant's snapshot takes the links that name a page by its path or
 * file alone, as the routes it keys pages by (`assistant`).
 */

/** The page a Markdown text was written for. */
export interface LinkedPage {
  /**
   * A staged page's path under its staging dir, which its links resolve from
   * when it has no `sourcePath` (a remote or CMS source).
   */
  entryId?: string;
  route: string;
  sourcePath?: string;
}

/** Rewrite a page's relative page links to the routes they mean. */
export type RelativeLinkRewriter = (text: string, page: LinkedPage) => string;

/** Who reads the rewritten links. */
export interface RelativeLinkOptions {
  /**
   * The assistant's snapshot, rather than a page an agent fetches by URL.
   * Only a link that names a page by its relative path or its content file
   * changes, to the route the snapshot keys that page by: without the
   * `deployment.base`, since the chat panel mounts every link it renders
   * under it, and a locale's fallback copy as the page it renders, since the
   * snapshot holds that page instead. Root page links and images stay as
   * written.
   */
  assistant?: boolean;
}

/**
 * Whether a text could hold a relative page link at all: an inline link, a
 * reference definition, or a component `href` whose target isn't a URL with
 * a scheme, a root path, or a fragment. Most pages hold none, and those skip
 * the link parse and the line-by-line fence scan entirely.
 */
const MAYBE_RELATIVE =
  /\]\([\t ]*<?(?![a-z][\d+.a-z-]*:|\/|#)|^ {0,3}\[[^\]\n]+\]:[\t ]*<?(?![a-z][\d+.a-z-]*:|\/|#)|\shref=["'](?![a-z][\d+.a-z-]*:|\/|#)/imu;

/**
 * {@link MAYBE_RELATIVE}, or a root-relative target (`/x`, never `//host`):
 * the gate when root-relative links are rewritten too — a base or basePath is
 * set, or the page sits under a locale prefix.
 */
const MAYBE_PAGE_LINK =
  /\]\([\t ]*<?(?![a-z][\d+.a-z-]*:|\/\/|#)|^ {0,3}\[[^\]\n]+\]:[\t ]*<?(?![a-z][\d+.a-z-]*:|\/\/|#)|\shref=["'](?![a-z][\d+.a-z-]*:|\/\/|#)/imu;

/**
 * Whether a text could hold a root-relative link to a Markdown file
 * (`[x](/guide/new.md)`), which lands on that file's page whatever the base.
 */
const MAYBE_ROOT_FILE =
  /(?:\]\(|\]:|\shref=["'])[\t ]*<?\/(?!\/)[^\s"'()<>]*\.mdx?\b/imu;

interface Splice {
  column: number;
  length: number;
  text: string;
}

/** Apply same-line splices, right to left so earlier columns stay valid. */
const spliceLine = (line: string, splices: readonly Splice[]): string => {
  let out = line;
  for (const splice of splices.toSorted((a, b) => b.column - a.column)) {
    out =
      out.slice(0, splice.column) +
      splice.text +
      out.slice(splice.column + splice.length);
  }
  return out;
};

/**
 * Every routed splice in `text`, by 0-based line: links, images, and
 * reference definitions, as `extractLinks` finds them. An image target goes
 * through `imaged`, everything else through `routed`, told whether it's a
 * raw HTML element's.
 */
const collectSplices = (
  text: string,
  routed: (target: string, raw: boolean) => string | undefined,
  imaged: (target: string) => string | undefined
): Map<number, Splice[]> => {
  const splices = new Map<number, Splice[]>();
  const add = (index: number, splice: Splice): void => {
    splices.set(index, [...(splices.get(index) ?? []), splice]);
  };
  for (const link of extractLinks(text)) {
    const route = link.image
      ? imaged(link.target)
      : routed(link.target, link.raw === true);
    if (route !== undefined) {
      add(link.line - 1, {
        column: link.column - 1,
        length: link.sourceLength ?? link.target.length,
        text: route,
      });
    }
  }
  return splices;
};

/** What a project's links resolve through, whoever reads them. */
interface LinkIndex {
  fileRoutes: FileRouteIndex;
  localeByRoute: Map<string, string>;
  navPathBySource: Map<string | undefined, string>;
  routes: Set<string>;
}

// The mirrors, llms-full.txt and the assistant's snapshot each build a
// rewriter for the same project, so the lookups behind them are built once.
const linkIndexes = new WeakMap<BlumeProject, LinkIndex>();

/**
 * The file → route lookup a `.md`/`.mdx` link resolves through, and the
 * routes a link can land on. A file shared by every locale publishes once
 * per locale, and the default locale's route stands for it; fallback copies
 * render another locale's file, so they never stand for one.
 */
const linkIndex = (project: BlumeProject): LinkIndex => {
  let index = linkIndexes.get(project);
  if (!index) {
    const { config, graph, manifest } = project;
    index = {
      fileRoutes: buildFileRouteIndex(graph.pages, config.i18n ?? null),
      localeByRoute: new Map(
        manifest.routes.map((route) => [route.path, route.locale])
      ),
      navPathBySource: new Map(
        graph.pages.map((page) => [page.sourcePath, page.navPath])
      ),
      routes: new Set(manifest.routes.map((route) => route.path)),
    };
    linkIndexes.set(project, index);
  }
  return index;
};

/**
 * A resolved route as the assistant's snapshot keys it. A locale's fallback
 * copy (`/fr/guides/install` with no French page there) renders another
 * locale's page, which the snapshot holds in its place, so the route becomes
 * that page's; every other route is kept, `?query#hash` and all.
 */
const snapshotRoute = (project: BlumeProject): ((route: string) => string) => {
  const pageRoutes = new Map(
    project.graph.pages.map((page) => [page.id, page.route])
  );
  const rendered = new Map<string, string>();
  for (const route of project.manifest.routes) {
    const page = route.fallback ? pageRoutes.get(route.id) : undefined;
    if (page !== undefined) {
      rendered.set(route.path, page);
    }
  }
  return (route) => {
    const suffixAt = route.search(/[?#]/u);
    const path = suffixAt === -1 ? route : route.slice(0, suffixAt);
    const page = rendered.get(path);
    return page === undefined ? route : `${page}${route.slice(path.length)}`;
  };
};

/**
 * Build the rewriter for a project, for an agent reading a page by URL or,
 * with `assistant`, for the assistant's snapshot.
 */
export const relativeLinkRewriter = (
  project: BlumeProject,
  options: RelativeLinkOptions = {}
): RelativeLinkRewriter => {
  const { basePath, deployment, i18n } = project.config;
  // Links are read under the real deployment base whoever reads them, so a
  // root link to a content file that carries it is still recognized.
  const deployBase = normalizeBasePath(deployment.options.base);
  const contentRoot = resolveDocsCollection(
    project.config,
    project.context.root
  ).base;
  const localeTokens = i18n
    ? ["$", ...i18n.locales.map((locale) => locale.code)]
    : [];
  const { fileRoutes, localeByRoute, navPathBySource, routes } =
    linkIndex(project);
  const hasRoute = (path: string): boolean => routes.has(path);

  // Where a resolved route lands for its reader. A route Blume serves takes
  // the deployment base unconditionally — even over a route that starts with
  // the base's name — except in the assistant's snapshot.
  const land = options.assistant
    ? snapshotRoute(project)
    : (route: string): string => mountBasePath(deployBase, route);

  /**
   * How a page's root-relative links change, if they do: when the site is
   * mounted under a prefix, or the page reads in a prefixed locale, whose
   * copy of a route they move to. The assistant's snapshot keeps them as
   * written.
   */
  const rootLinksOf = (
    route: string
  ): { localize?: LocalizeHrefOptions } | undefined => {
    if (options.assistant) {
      return undefined;
    }
    const locale = localeByRoute.get(route);
    const localize =
      i18n && locale !== undefined && localePrefix(locale, i18n) !== ""
        ? { basePath, deployBase, i18n, locale, routes }
        : undefined;
    return deployBase !== "" || basePath !== "" || localize !== undefined
      ? { localize }
      : undefined;
  };

  /**
   * A page's relative-link resolver; `undefined` when the page has no file
   * to resolve its links from.
   */
  const relativeRoute = (
    page: LinkedPage
  ): ((target: string) => string | undefined) | undefined => {
    const { entryId, sourcePath } = page;
    const file = sourcePath ?? entryId;
    if (!file) {
      return;
    }
    const from: RelativeLinkBase = {
      isIndex: isIndexFileName(basename(file), localeTokens),
      route: page.route,
    };
    // A staged page (a remote or CMS source) has no file on disk: it
    // resolves a sibling by its entry id, as `blume validate` does.
    let resolveFile: (path: string) => string | undefined;
    if (sourcePath) {
      const navPath = navPathBySource.get(sourcePath) ?? basename(sourcePath);
      resolveFile = (path) =>
        routeOfLinkedFile(fileRoutes, { navPath, sourcePath }, path);
    } else {
      resolveFile = (path) => routeOfLinkedEntry(fileRoutes, file, path);
    }
    return (target) => resolveRelativeHref(target, from, resolveFile, hasRoute);
  };

  /** Whether a page is served at a based, fragment-less path. */
  const servesPage = (route: string): boolean => servesRoute(routes, route);

  return (text, page) => {
    const rootLinks = rootLinksOf(page.route);
    const localize = rootLinks?.localize;
    if (
      !(page.sourcePath || page.entryId || rootLinks) ||
      !(
        (rootLinks ? MAYBE_PAGE_LINK : MAYBE_RELATIVE).test(text) ||
        MAYBE_ROOT_FILE.test(text)
      )
    ) {
      return text;
    }
    const relative = relativeRoute(page);
    // What the rendered page makes of `/guide`: based (a public file like
    // `/spec.pdf` under the deployment base alone), then moved into the
    // page's locale when that route is served.
    const rooted = (target: string): string | undefined => {
      const based = withAuthoredBasePath(
        deployBase,
        basePath,
        target,
        servesPage
      );
      const href = localize ? localizeHref(based, localize) : based;
      return href === target ? undefined : href;
    };
    // A root-relative link naming a content file (`/guide/new.md`) means
    // that file's page, as a relative one does; a raw `<a href>` keeps it,
    // as the rendered page's does.
    const rootFile = (target: string): string | undefined => {
      const route = resolveRootFileHref(target, {
        contentRoot,
        deployBase,
        routeOfFile: (file) => fileRoutes.bySource.get(file),
      });
      if (route === undefined) {
        return undefined;
      }
      const landed = land(route);
      return localize ? localizeHref(landed, localize) : landed;
    };
    const routed = (target: string, raw: boolean): string | undefined => {
      if (!isInternalPath(target)) {
        const route = raw
          ? resolveRawRelativeHref(target, page.route, hasRoute)
          : relative?.(target);
        return route === undefined ? undefined : land(route);
      }
      const file = raw ? undefined : rootFile(target);
      return file ?? (rootLinks ? rooted(target) : undefined);
    };
    // An image is always a file: `public/` (or a generated asset endpoint),
    // served under the deployment base but never `basePath`. A relative one
    // is left to `core/content-assets.ts`.
    const imaged = (target: string): string | undefined => {
      const based = rootLinks ? withBasePath(deployBase, target) : target;
      return based === target ? undefined : based;
    };

    const lines = text.split("\n");
    const splices = collectSplices(text, routed, imaged);

    return lines
      .map((line, index) => {
        const lineSplices = splices.get(index);
        return lineSplices ? spliceLine(line, lineSplices) : line;
      })
      .join("\n");
  };
};
