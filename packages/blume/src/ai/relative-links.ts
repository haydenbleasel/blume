import { basename } from "pathe";

import {
  decodedPath,
  isInternalPath,
  mountBasePath,
  normalizeBasePath,
  stripBasePath,
  withAuthoredBasePath,
  withBasePath,
} from "../core/base-path.ts";
import { localePrefix } from "../core/i18n.ts";
import {
  buildFileRouteIndex,
  isIndexFileName,
  isOffSitePath,
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
import { encodeTargetChars } from "./link-text.ts";

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
 * (`components/layout/LocaleLinks.astro`), as a resolved relative link does
 * there too. A root-relative link to a content file (`/guide/new.md`) lands
 * on that file's page, as on the rendered page (`resolveRootFileHref`).
 * Inline links, images, component `href`s, and reference definitions are
 * rewritten; fenced and inline code (indented too, on a `.md` page),
 * comments, relative images and asset links, and external URLs are left as
 * written. A resolved route a Markdown destination can't hold as written
 * (`my page`) is percent-encoded. The assistant's snapshot takes page links
 * as the routes it keys pages by (`assistant`).
 */

/** The page a Markdown text was written for. */
export interface LinkedPage {
  /**
   * A staged page's path under its staging dir, which its links resolve from
   * when it has no `sourcePath` (a remote or CMS source).
   */
  entryId?: string;
  /** The page's format: a `.md` page's indented code is left as written. */
  format?: "md" | "mdx";
  route: string;
  sourcePath?: string;
}

/** Rewrite a page's relative page links to the routes they mean. */
export type RelativeLinkRewriter = (text: string, page: LinkedPage) => string;

/** Who reads the rewritten links. */
export interface RelativeLinkOptions {
  /**
   * The assistant's snapshot, rather than a page an agent fetches by URL. A
   * page link lands on the route the snapshot keys that page by: without the
   * `deployment.base`, since the chat panel mounts every link it renders
   * under it, and a locale's fallback copy as the page it renders, since the
   * snapshot holds that page instead. Images stay as written.
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
  format: LinkedPage["format"],
  routed: (target: string, raw: boolean) => string | undefined,
  imaged: (target: string) => string | undefined
): Map<number, Splice[]> => {
  const splices = new Map<number, Splice[]>();
  const add = (index: number, splice: Splice): void => {
    splices.set(index, [...(splices.get(index) ?? []), splice]);
  };
  for (const link of extractLinks(text, 0, format)) {
    const route = link.image
      ? imaged(link.target)
      : routed(link.target, link.raw === true);
    if (route !== undefined) {
      add(link.line - 1, {
        column: link.column - 1,
        length: link.sourceLength ?? link.target.length,
        // A route can hold a space, a parenthesis or a quote (`my page.md`
        // publishes at `/my page`), which would end or split the link or the
        // attribute it's written in.
        text: encodeTargetChars(route, /[\s"'()<>]/gu),
      });
    }
  }
  return splices;
};

/** What a project's links resolve through, whoever reads them. */
interface LinkIndex {
  fileRoutes: FileRouteIndex;
  localeByRoute: Map<string, string>;
  /** A page's source file → where it sits for a default-tree lookup. */
  fileBySource: Map<string | undefined, { navPath: string; version: string }>;
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
      fileBySource: new Map(
        graph.pages.map((page) => [
          page.sourcePath,
          { navPath: page.navPath, version: page.version },
        ])
      ),
      fileRoutes: buildFileRouteIndex(graph.pages, config.i18n ?? null),
      localeByRoute: new Map(
        manifest.routes.map((route) => [route.path, route.locale])
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
 * that page's; every other route is kept, `?query#hash` and all. The copy is
 * looked up decoded, so a link that percent-encodes it (`/fr/my%20page`) is
 * found too.
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
    const page = rendered.get(decodedPath(path));
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
  const { fileBySource, fileRoutes, localeByRoute, routes } =
    linkIndex(project);
  const hasRoute = (path: string): boolean => routes.has(path);

  const toSnapshot = options.assistant ? snapshotRoute(project) : undefined;

  /** An href without the deployment base, `?query#hash` kept. */
  const unmounted = (href: string): string => {
    const suffixAt = href.search(/[?#]/u);
    const path = suffixAt === -1 ? href : href.slice(0, suffixAt);
    return `${stripBasePath(deployBase, path)}${suffixAt === -1 ? "" : href.slice(suffixAt)}`;
  };

  /**
   * Where a link lands for its reader, from the href the rendered page serves
   * (`deployment.base` and all, which a route Blume serves takes even when it
   * starts with the base's name): moved into the page's locale when that copy
   * of the route is served, as `LocaleLinks.astro` moves it, and for the
   * assistant's snapshot without the base, a fallback copy read as the page
   * it renders.
   */
  const landOn = (
    href: string,
    localize: LocalizeHrefOptions | undefined
  ): string => {
    const localized = localize ? localizeHref(href, localize) : href;
    if (!toSnapshot) {
      return localized;
    }
    // A link that carries the base over an off-site path (`/sub//host`)
    // would read as another site's without it; it stays as it is.
    const route = unmounted(localized);
    return isOffSitePath(route) ? localized : toSnapshot(route);
  };

  // In the snapshot, a link to a fallback copy reads as the page it renders,
  // from whichever page links it.
  const mapsCopies =
    toSnapshot !== undefined &&
    project.manifest.routes.some((route) => route.fallback);

  /**
   * How a page's root-relative links change, if they do: when the site is
   * mounted under a prefix, the page reads in a prefixed locale, whose copy
   * of a route they move to, or the snapshot maps fallback copies.
   */
  const rootLinksOf = (
    route: string
  ): { localize?: LocalizeHrefOptions } | undefined => {
    const locale = localeByRoute.get(route);
    const localize =
      i18n && locale !== undefined && localePrefix(locale, i18n) !== ""
        ? { basePath, deployBase, i18n, locale, routes }
        : undefined;
    return deployBase !== "" ||
      basePath !== "" ||
      localize !== undefined ||
      mapsCopies
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
      const { navPath, version } = fileBySource.get(sourcePath) ?? {
        navPath: basename(sourcePath),
        version: "",
      };
      resolveFile = (path) =>
        routeOfLinkedFile(fileRoutes, { navPath, sourcePath, version }, path);
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
      const href = landOn(
        withAuthoredBasePath(deployBase, basePath, target, servesPage),
        localize
      );
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
      return route === undefined
        ? undefined
        : landOn(mountBasePath(deployBase, route), localize);
    };
    const routed = (target: string, raw: boolean): string | undefined => {
      if (!isInternalPath(target)) {
        const route = raw
          ? resolveRawRelativeHref(target, page.route, hasRoute)
          : relative?.(target);
        return route === undefined
          ? undefined
          : landOn(mountBasePath(deployBase, route), localize);
      }
      const file = raw ? undefined : rootFile(target);
      return file ?? (rootLinks ? rooted(target) : undefined);
    };
    // An image is always a file: `public/` (or a generated asset endpoint),
    // served under the deployment base but never `basePath`. A relative one
    // is left to `core/content-assets.ts`, and the assistant's snapshot
    // leaves them all as written.
    const imaged = (target: string): string | undefined => {
      const based =
        rootLinks && !options.assistant
          ? withBasePath(deployBase, target)
          : target;
      return based === target ? undefined : based;
    };

    const lines = text.split("\n");
    const splices = collectSplices(text, page.format, routed, imaged);

    return lines
      .map((line, index) => {
        const lineSplices = splices.get(index);
        return lineSplices ? spliceLine(line, lineSplices) : line;
      })
      .join("\n");
  };
};
