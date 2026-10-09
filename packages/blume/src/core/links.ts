import { existsSync, readFileSync, statSync } from "node:fs";

import { basename, dirname, join, normalize, relative, resolve } from "pathe";

import { isInternalPath, stripBasePath, withBasePath } from "./base-path.ts";
import { locatePath } from "./diagnostics.ts";
import type { LocaleRouting } from "./i18n.ts";
import { localizeLinkPath } from "./locale-links.ts";
import { gradeExternal, probeAll } from "./probe.ts";
import {
  destinationPrefix,
  isPatternPath,
  pathsUnderPattern,
} from "./redirect-patterns.ts";
import {
  isRelativeImageTarget,
  resolveRelativeFile,
  resolveRelativeImage,
} from "./relative-files.ts";
import { staticFileResolver } from "./static-files.ts";
import type {
  ContentGraph,
  Diagnostic,
  PageLink,
  PageRecord,
} from "./types.ts";

const HTTP = /^https?:\/\//iu;
const PROTOCOL_RELATIVE = /^\/\//u;
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * Link schemes only one docs platform understands: ReadMe resolves
 * `doc:slug`, `ref:slug`, `page:slug`, `changelog:slug`, and `blog:slug` to
 * its own pages, but no browser or app handles them, so each ships as a dead
 * `href`. A denylist, not an allowlist of web schemes: an app's deep link
 * (`vscode:`, `cursor://`, `slack://`) is as real a link as `mailto:`, and
 * which apps a reader has installed can't be known here.
 */
const PLATFORM_SCHEMES = new Set([
  "blog:",
  "changelog:",
  "doc:",
  "page:",
  "ref:",
]);

/** Percent-decode a link piece; malformed sequences stay verbatim. */
const decodePercent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const DOC_EXT = /\.(?:md|mdx)$/iu;
const FILE_EXT = /\.[a-z0-9]+$/iu;

/** Source position shared by every diagnostic raised for a link. */
interface LinkSite {
  column: number;
  file: string;
  line: number;
}

/**
 * Message context for a link written inside an included partial whose verdict
 * depends on *which* page splices it (relative paths resolve against the
 * including page's route; bare anchors against its headings). Without it the
 * same partial line can be reported broken while being valid from another
 * includer — with no way to tell the reports apart.
 */
const includedBySuffix = (link: PageLink, page: PageRecord): string =>
  link.file ? ` (included by ${basename(page.sourcePath ?? page.id)})` : "";

/**
 * Invert the include image rebase for display: expansion rewrote a partial's
 * relative image target into the including page's directory so it resolves,
 * but the diagnostic points at the partial — report the path the author
 * actually wrote there, not the rebased one they never typed.
 */
const authoredImageTarget = (
  target: string,
  pagePath: string,
  partialPath: string
): string => {
  const authored = relative(
    dirname(partialPath),
    resolve(dirname(pagePath), target)
  );
  return authored.startsWith(".") ? authored : `./${authored}`;
};

/** An external link occurrence queued for a network probe. */
interface ExternalRef extends LinkSite {
  url: string;
}

/** Lookups derived once from the content graph. */
interface LinkContext {
  anchors: Map<string, Set<string>>;
  /** Site-wide route mount point (`""` or `/seg`); routes carry it, assets don't. */
  basePath: string;
  /** The route a root-relative link to a content file (`/guide/new.md`)
   * lands on, when it names one (see `resolveRootFileHref`). */
  rootFileRoute: (href: string) => string | undefined;
  /** Servable routes outside the graph (custom pages, generated routes); their
   * headings are unknown, so anchors there are accepted unchecked. */
  extraRoutes: Set<string>;
  /** Where content files publish, for file links (`./setup.mdx`). */
  fileRoutes: FileRouteIndex;
  /** Locale routing, when the site is multi-locale; drives served-route resolution. */
  i18n: LocaleRouting | null;
  /** Normalized `redirect.from` paths — valid targets that resolve at runtime. */
  redirects: Set<string>;
  /** Pattern `redirect.from`s (`/beta/:slug*`), based like `redirects`. */
  redirectPatterns: string[];
  routes: Set<string>;
  /** Whether a base-less path is a `public/` file (a folder's `index.html`
   * included) or a file Blume generates (see `staticFileResolver`). */
  servesFile: (path: string) => boolean;
}

/** Outcome of classifying one link target. */
type LinkResult = Diagnostic | null;

// Mirrors the ordering-prefix strip in `sources/normalize.ts`: route mapping
// drops the prefix before recognizing `index`, so `01-index.mdx` is an index.
const NUMERIC_PREFIX = /^\d+[-_.]/u;

/**
 * Whether a page is a directory index (`…/index.md(x)`, ordering prefix
 * ignored). Its route already *is* its directory, so a relative link must
 * resolve against the route itself, not its parent — otherwise `./sibling`
 * from `guides/index.mdx` (route `/guides`) would resolve to `/sibling` and be
 * falsely flagged as broken. Tested against `navPath` — the locale-stripped
 * path — so a dot-parser localized index (`index.fr.mdx`) and a shared
 * locale-agnostic one (`index.$.mdx`) count too, matching how route mapping
 * recognizes them. Only a lowercase `index` counts, as in route mapping:
 * `Index.md` publishes at `…/Index`, a page of its own.
 */
const isIndexPage = (page: PageRecord): boolean =>
  /^index\.[Mm][Dd][Xx]?$/u.test(
    basename(page.navPath).replace(NUMERIC_PREFIX, "")
  );

/** Apply one relative-path segment to the accumulated route segments. */
const applyRelativePart = (segments: string[], part: string): void => {
  if (part === "" || part === ".") {
    return;
  }
  if (part === "..") {
    segments.pop();
    return;
  }
  segments.push(part);
};

/** Resolve a relative link target against the directory of a page route. */
const resolveRelative = (
  pageRoute: string,
  target: string,
  isIndex: boolean
): string => {
  const segments = pageRoute.split("/").filter(Boolean);
  // Drop a leaf page's own segment so links resolve against its parent
  // directory. An index page's route already is its directory, so keep it.
  if (!isIndex) {
    segments.pop();
  }
  for (const part of target.split("/")) {
    applyRelativePart(segments, part);
  }
  return `/${segments.join("/")}`;
};

/** Normalize an internal path to its canonical route form. */
const toRoute = (path: string): string => {
  let route = path.replace(DOC_EXT, "");
  if (route.endsWith("/index")) {
    route = route.slice(0, -"/index".length);
  }
  if (route.length > 1 && route.endsWith("/")) {
    route = route.slice(0, -1);
  }
  return route === "" ? "/" : route;
};

/** The page a relative link is written on, as the resolver sees it. */
export interface RelativeLinkBase {
  /** Whether the page is its folder's index (its route is its directory). */
  isIndex: boolean;
  /** The page's own route, base path included. */
  route: string;
}

/** A root-relative path, a bare `#fragment` or `?query`, or any scheme. */
const NOT_RELATIVE = /^(?:[#?/]|[a-z][a-z0-9+.-]*:)/iu;

/** The same file under the other Markdown extension: `x.md` ↔ `x.mdx`. */
const otherDocExtension = (path: string): string =>
  /x$/iu.test(path) ? path.slice(0, -1) : `${path}x`;

/**
 * Where a relative page link written on `from` lands: a root-relative route
 * with the authored `?query#hash` kept — or `undefined` when `href` isn't a
 * relative page link (a root-relative path, a bare `#fragment` or `?query`,
 * an external URL or other scheme, or a relative asset like `./diagram.png`).
 *
 * The one reading `blume validate` checks links against and the Markdown
 * pipeline rewrites them to, so the built `href`, the link check, and the
 * browser agree. Relative paths resolve file-style: a leaf page's links
 * resolve against its parent directory, while an index page's route already is
 * its directory — `./install` on `guides/index.mdx` (`/guides`) lands on
 * `/guides/install`, where a browser reading the slashless URL would go to
 * `/install`. A `.md`/`.mdx` target is a file link: `resolveFile` maps its
 * decoded path, relative to the linking file, to the route that file
 * publishes at, so a target with its own `slug` or an ordering prefix still
 * lands on its page instead of on its raw Markdown source. A file renamed
 * from `.md` to `.mdx`, or back, is found under its other extension first,
 * so a link written before the rename keeps that slug or prefix. Without
 * `resolveFile`, or for a file it doesn't know, the target resolves
 * route-relative with the extension dropped.
 *
 * Any other extension (`./diagram.png`) marks an asset, except where a page
 * publishes at the resolved path: `hasRoute` answers that, so a dotted page
 * name (`./node.js` for `node.js.mdx`, `./v1.2`) is still a page link.
 */
export const resolveRelativeHref = (
  href: string,
  from: RelativeLinkBase,
  resolveFile?: (path: string) => string | undefined,
  hasRoute?: (route: string) => boolean
): string | undefined => {
  if (href === "" || NOT_RELATIVE.test(href)) {
    return undefined;
  }
  const suffixAt = href.search(/[?#]/u);
  const path = suffixAt === -1 ? href : href.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : href.slice(suffixAt);
  if (FILE_EXT.test(path) && !DOC_EXT.test(path)) {
    const route = toRoute(resolveRelative(from.route, path, from.isIndex));
    return hasRoute?.(decodePercent(route)) ? `${route}${suffix}` : undefined;
  }
  const file = decodePercent(path);
  const fileRoute = DOC_EXT.test(path)
    ? (resolveFile?.(file) ?? resolveFile?.(otherDocExtension(file)))
    : undefined;
  return `${fileRoute ?? toRoute(resolveRelative(from.route, path, from.isIndex))}${suffix}`;
};

/**
 * Where a root-relative link to a content file (`/guide/new.md`, the way
 * VitePress, Docsify, and TypeDoc write one) lands: the route of the source
 * file it names under the content root, with the authored `?query#hash`
 * kept, or `undefined` when it names no source file (or isn't a root-relative
 * `.md`/`.mdx` link at all). It's read as written from the content root, or,
 * when it starts with `deployment.base`, as including the base (see
 * `withBasePath`). `routeOfFile` maps an absolute source path to the route
 * that file publishes at. A link that names no source file is left alone:
 * `/guide/new.md` is also the URL of a page's Markdown copy, which a link may
 * mean on purpose.
 */
export const resolveRootFileHref = (
  href: string,
  options: {
    contentRoot: string;
    deployBase: string;
    routeOfFile: (file: string) => string | undefined;
  }
): string | undefined => {
  if (!isInternalPath(href)) {
    return undefined;
  }
  const suffixAt = href.search(/[?#]/u);
  const path = suffixAt === -1 ? href : href.slice(0, suffixAt);
  if (!DOC_EXT.test(path)) {
    return undefined;
  }
  const route = options.routeOfFile(
    join(
      options.contentRoot,
      stripBasePath(options.deployBase, decodePercent(path))
    )
  );
  return route === undefined
    ? undefined
    : `${route}${suffixAt === -1 ? "" : href.slice(suffixAt)}`;
};

/**
 * Whether a content file is its folder's index, from its name as written on
 * disk: `index.md(x)` after an ordering prefix, optionally carrying one of
 * `localeTokens` before the extension (`index.fr.mdx` under the `dot` locale
 * parser, `index.$.mdx` for a file shared by every locale). The `index` itself
 * is case-sensitive, as route mapping reads it: `Index.md` is a page named
 * `Index`, not its folder's index.
 */
export const isIndexFileName = (
  name: string,
  localeTokens: readonly string[] = []
): boolean => {
  const stem = basename(name).replace(NUMERIC_PREFIX, "");
  const match = /^index(?:\.(?<token>[^./]+))?\.[Mm][Dd][Xx]?$/u.exec(stem);
  if (!match) {
    return false;
  }
  const token = match.groups?.token;
  return token === undefined || localeTokens.includes(token);
};

/** Build a map of route -> set of heading anchor slugs. */
const buildAnchorIndex = (pages: PageRecord[]): Map<string, Set<string>> => {
  const anchors = new Map<string, Set<string>>();
  for (const page of pages) {
    anchors.set(
      page.route,
      new Set([
        ...page.headings.map((heading) => heading.slug),
        ...page.anchors,
      ])
    );
  }
  return anchors;
};

/** Verify a fragment resolves to a heading on the target route. */
const checkAnchor = (
  route: string,
  fragment: string,
  site: LinkSite,
  ctx: LinkContext,
  via = ""
): Diagnostic | null => {
  const anchors = ctx.anchors.get(route);
  // Exact first: a `[#custom-id]` pin may contain uppercase, which the
  // lowercase fallback (lenient matching for slugger-generated ids) would miss.
  if (anchors?.has(fragment) || anchors?.has(fragment.toLowerCase())) {
    return null;
  }
  return {
    ...site,
    code: "BLUME_BROKEN_ANCHOR",
    message: `No anchor target on ${route} matches #${fragment}${via}.`,
    severity: "warning",
  };
};

/**
 * The route a link on `page` actually lands on. Rendered under a prefixed
 * locale, a root-relative link moves into that locale when the localized route
 * is served — a real translation (whose own headings then answer the anchor
 * check) or a fallback page (accepted unchecked via `extraRoutes`) — exactly as
 * `LocaleLinks.astro` rewrites it at render time. Otherwise the authored route
 * stands.
 */
const servedRoute = (
  authored: string,
  page: PageRecord,
  ctx: LinkContext
): string =>
  ctx.i18n
    ? localizeLinkPath(authored, {
        basePath: ctx.basePath,
        i18n: ctx.i18n,
        locale: page.locale,
        routes: {
          has: (route) => ctx.routes.has(route) || ctx.extraRoutes.has(route),
        },
      })
    : authored;

/**
 * The fix for a relative link to a content file that exists but is a
 * partial: a name starting with `_`, or a file under such a folder, which
 * the default `content.exclude` leaves unpublished. Undefined for any other
 * link, whose file is missing or was left out for another reason.
 */
const partialLinkHint = (
  link: PageLink,
  page: PageRecord
): string | undefined => {
  const path = decodePercent(link.target.split(/[?#]/u)[0] ?? "");
  if (
    link.raw ||
    !page.sourcePath ||
    path.startsWith("/") ||
    !DOC_EXT.test(path) ||
    !path.split("/").some((segment) => segment.startsWith("_")) ||
    !existsSync(resolve(dirname(page.sourcePath), path))
  ) {
    return undefined;
  }
  return `${path} exists, but a name starting with "_" marks a partial, which isn't published as a page. Splice it in with <include> instead, rename it to publish it, or add "!**/_*" to content.exclude to publish every underscore file.`;
};

const HTML_EXT = /\.html?$/iu;

/**
 * The page an `.html` link means, when one is served there: `/guides/setup`
 * for `/guides/setup.html`, `/guides` for `/guides/index.html`. A page is
 * served at its route, never at an `.html` URL (only a `public/` file is),
 * so the link 404s, and this is the route to link instead. Resolved like
 * any page link: based unless raw, then moved into the reader's locale.
 */
const htmlPageRoute = (
  resolved: string,
  page: PageRecord,
  link: PageLink,
  ctx: LinkContext
): string | undefined => {
  if (!HTML_EXT.test(resolved)) {
    return undefined;
  }
  const path = resolved.replace(HTML_EXT, "");
  const authored = toRoute(link.raw ? path : withBasePath(ctx.basePath, path));
  const route = servedRoute(authored, page, ctx);
  return ctx.routes.has(route) || ctx.extraRoutes.has(route)
    ? authored
    : undefined;
};

/**
 * Validate a link to a file (`./spec.pdf`, `/logo.png`, `![](./a.png)`) that
 * no route, redirect, or public file answers: an image embed or a link
 * beside the page, or else a missing file.
 */
const checkFileLink = (
  resolved: string,
  assetPath: string,
  page: PageRecord,
  link: PageLink,
  site: LinkSite,
  ctx: LinkContext,
  via: string
): LinkResult => {
  // A colocated image embed (`![](./diagram.png)`) is resolved from beside
  // the page source and emitted to `_astro/` by the image pipeline, so it
  // never lands in `public/`. The *raw* target goes through the same
  // resolver that decides what the `/blume-assets/content` endpoint serves,
  // so a reference the rewriter skips (a `?v=2` suffix, a double-encoded
  // name) is reported here, not accepted.
  if (link.image && page.sourcePath && isRelativeImageTarget(link.target)) {
    if (resolveRelativeImage(dirname(page.sourcePath), link.target)) {
      return null;
    }
    // A partial-origin image was rebased into the page's directory for
    // resolution but reports against the partial — cite the path as
    // authored there, so file, path, and "next to" agree.
    const authored = link.file
      ? authoredImageTarget(link.target, page.sourcePath, link.file)
      : link.target;
    return {
      ...site,
      code: "BLUME_BROKEN_ASSET",
      message: `Image ${authored} was not found next to ${basename(link.file ?? page.sourcePath)}.`,
      severity: "warning",
      suggestion: "Add the file next to the page source or fix the reference.",
    };
  }
  // A relative link to any other file beside the page (`./spec.pdf`) is
  // published with it and pointed at its served copy, by the same resolver
  // (see `core/content-assets.ts`); an image embed of one isn't.
  if (
    !link.image &&
    page.sourcePath &&
    resolveRelativeFile(dirname(page.sourcePath), link.target)
  ) {
    return null;
  }
  const pageRoute = htmlPageRoute(resolved, page, link, ctx);
  if (pageRoute !== undefined) {
    return {
      ...site,
      code: "BLUME_BROKEN_ASSET",
      message: `Link ${link.target}${via} points at ${assetPath}, which public/ doesn't have, and pages aren't served at .html URLs.`,
      severity: "warning",
      suggestion: `Link the page at ${pageRoute} instead.`,
    };
  }
  // With no `public/` folder at all, the site ships no such file either.
  return {
    ...site,
    code: "BLUME_BROKEN_ASSET",
    message: `Asset ${assetPath} was not found in the public directory.`,
    severity: "warning",
    suggestion: `Add the file at public${assetPath} or fix the link.`,
  };
};

/** Validate a resolved internal path: asset, route, then optional anchor. */
const checkPathLink = (
  resolved: string,
  fragment: string,
  page: PageRecord,
  link: PageLink,
  site: LinkSite,
  ctx: LinkContext,
  via = ""
): LinkResult => {
  // Page routes carry the site-wide base; an absolute author path is written
  // as if mounted at root, so base it for the route lookup (idempotent — a
  // relative link already resolved against the based `page.route`). A raw
  // `<a href>` ships unbased, so it's looked up as written. A real route
  // always wins over the asset-extension heuristic, so a dotted route (e.g.
  // `/releases/v1.0`) isn't misread as a missing asset.
  const authoredRoute = toRoute(
    link.raw ? resolved : withBasePath(ctx.basePath, resolved)
  );
  const route = servedRoute(authoredRoute, page, ctx);
  if (ctx.routes.has(route)) {
    return fragment ? checkAnchor(route, fragment, site, ctx, via) : null;
  }
  // A custom `.astro` page or generated route serves this path, but its
  // headings aren't indexed — accept any fragment rather than false-flag it.
  if (ctx.extraRoutes.has(route)) {
    return null;
  }
  // A configured `redirect.from`, or a path a pattern `from` covers, resolves
  // at runtime, so it's a valid target.
  // Its destination (and any anchor there) is validated on its own page, so we
  // don't follow the redirect to check the fragment here.
  if (
    ctx.redirects.has(route) ||
    ctx.redirectPatterns.some(
      (from) => pathsUnderPattern(from, [route]).length > 0
    )
  ) {
    return null;
  }

  // Assets live in `public/` at the site root, unaffected by the base, so strip
  // it back off before probing the filesystem. Blume's own generated files
  // (`/llms.txt`, `/sitemap.xml`) sit beside them, and a `public/` folder
  // with an `index.html` is served at its path, as a static host serves it.
  const assetPath = stripBasePath(ctx.basePath, resolved);
  if (ctx.servesFile(assetPath)) {
    return null;
  }
  if (FILE_EXT.test(assetPath) && !DOC_EXT.test(assetPath)) {
    return checkFileLink(resolved, assetPath, page, link, site, ctx, via);
  }

  return {
    ...site,
    code: "BLUME_BROKEN_LINK",
    message: `Broken link to ${link.target}${via}: no page resolves to ${route}.`,
    severity: "error",
    suggestion:
      partialLinkHint(link, page) ??
      "Check the path, or create the target page.",
  };
};

/**
 * Validate a media element's `src` (`<img src>`, `<video src>`), which
 * `resolved` reads the way the browser does: a file the site serves at that
 * URL (in `public/`, or one Blume generates), or a relative path naming a
 * file beside the page, which the build publishes and points the `src` at
 * (see `core/content-assets.ts`). A partial's was rebased onto the page when
 * its file sits beside the partial.
 */
const checkSourceLink = (
  rawPath: string,
  resolved: string,
  page: PageRecord,
  link: PageLink,
  site: LinkSite,
  ctx: LinkContext,
  via: string
): LinkResult => {
  if (ctx.servesFile(resolved)) {
    return null;
  }
  const sourceFile = link.file ?? page.sourcePath;
  if (rawPath.startsWith("/") || sourceFile === undefined) {
    return {
      ...site,
      code: "BLUME_BROKEN_ASSET",
      message: `<${link.src} src="${link.target}">${via} points at ${resolved}, which isn't in the public directory.`,
      severity: "warning",
      suggestion: `Add the file at public${resolved} or fix the src.`,
    };
  }
  if (
    page.sourcePath &&
    resolveRelativeFile(dirname(page.sourcePath), link.target)
  ) {
    return null;
  }
  return {
    ...site,
    code: "BLUME_BROKEN_ASSET",
    message: `<${link.src} src="${link.target}">${via} points at ${resolved}, which isn't in the public directory, and there's no ${rawPath} next to ${basename(sourceFile)} either.`,
    severity: "warning",
    suggestion: "Fix the path, or add the file.",
  };
};

/** Probe queued external links with bounded concurrency. */
const checkExternalLinks = async (
  refs: ExternalRef[]
): Promise<Diagnostic[]> => {
  const results = await probeAll(refs.map((ref) => ref.url));

  const diagnostics: Diagnostic[] = [];
  for (const ref of refs) {
    const result = results.get(ref.url);
    const grade = result ? gradeExternal(result) : null;
    if (grade) {
      diagnostics.push({
        code: "BLUME_DEAD_LINK",
        column: ref.column,
        file: ref.file,
        line: ref.line,
        message: `External link ${ref.url} is unreachable (${grade.detail}).`,
        severity: grade.severity,
      });
    }
  }
  return diagnostics;
};

/** Where content files publish, for resolving file links (`./setup.mdx`). */
export interface FileRouteIndex {
  /**
   * Absolute source path → the route that file publishes at. A file shared by
   * every locale publishes once per locale; the default locale's route stands
   * for it (a link from a localized page moves into that locale afterwards,
   * exactly as the rendered link does). Fallback copies render another
   * locale's file, so they never stand for it.
   */
  bySource: Map<string, string>;
  /**
   * A default-locale page's locale-stripped path (`navPath`) → its route. A
   * page in a locale folder that links a sibling not translated yet
   * (`fr/guides/setup.mdx` missing) means the default tree's file
   * (`guides/setup.mdx`), whose route — its own `slug` included — then moves
   * into the reader's locale onto the fallback copy.
   */
  byDefaultNavPath: Map<string, string>;
  /**
   * A staged page's entry id (`<source>/<ref>`) → its route. A remote
   * source's files have no path on disk, so a file link between two of them
   * (`./02-errors.mdx`) resolves by entry id, as the rendered link does.
   */
  byEntryId: Map<string, string>;
}

/** The linking side of a file link: where the page's source lives. */
export interface FileLinkBase {
  navPath: string;
  sourcePath: string;
}

export const buildFileRouteIndex = (
  pages: readonly PageRecord[],
  i18n: LocaleRouting | null
): FileRouteIndex => {
  const bySource = new Map<string, string>();
  const byDefaultNavPath = new Map<string, string>();
  const byEntryId = new Map<string, string>();
  for (const page of pages) {
    const { entryId, sourcePath } = page;
    if (page.fallback) {
      continue;
    }
    const isDefault = page.locale === i18n?.defaultLocale;
    if (entryId && (!byEntryId.has(entryId) || isDefault)) {
      byEntryId.set(entryId, page.route);
    }
    if (!sourcePath) {
      continue;
    }
    if (!bySource.has(sourcePath) || isDefault) {
      bySource.set(sourcePath, page.route);
    }
    if (isDefault) {
      byDefaultNavPath.set(normalize(page.navPath), page.route);
    }
  }
  return { byDefaultNavPath, byEntryId, bySource };
};

/**
 * The route a file link written on `from` lands on: the linked file's own
 * route, or — when a locale folder doesn't have that file yet — the default
 * tree's file at the same place.
 */
export const routeOfLinkedFile = (
  index: FileRouteIndex,
  from: FileLinkBase,
  path: string
): string | undefined =>
  index.bySource.get(resolve(dirname(from.sourcePath), path)) ??
  index.byDefaultNavPath.get(normalize(join(dirname(from.navPath), path)));

/**
 * The route a file link written on a staged page lands on: the linked
 * entry's, by its path under the staging dir (`entryId`), as the rendered
 * link resolves it.
 */
export const routeOfLinkedEntry = (
  index: FileRouteIndex,
  entryId: string,
  path: string
): string | undefined =>
  index.byEntryId.get(normalize(join(dirname(entryId), path)));

/**
 * The path a relative link on `page` resolves to — the same reading the
 * Markdown pipeline rewrites the rendered `href` to (see
 * {@link resolveRelativeHref}), so what's checked is what ships. A relative
 * asset (`./diagram.png`) isn't a page link; it resolves against the route's
 * directory for the public-dir probe.
 */
const relativeTarget = (
  page: PageRecord,
  rawPath: string,
  ctx: LinkContext
): string => {
  const base = { isIndex: isIndexPage(page), route: page.route };
  const { entryId, navPath, sourcePath } = page;
  let resolveFile: ((path: string) => string | undefined) | undefined;
  if (sourcePath) {
    resolveFile = (path) =>
      routeOfLinkedFile(ctx.fileRoutes, { navPath, sourcePath }, path);
  } else if (entryId) {
    resolveFile = (path) => routeOfLinkedEntry(ctx.fileRoutes, entryId, path);
  }
  return (
    resolveRelativeHref(rawPath, base, resolveFile, (route) =>
      ctx.routes.has(route)
    ) ?? resolveRelative(page.route, rawPath, base.isIndex)
  );
};

/** The path a decoded, suffix-less internal link on `page` lands on. */
const resolveLinkPath = (
  page: PageRecord,
  link: PageLink,
  rawPath: string,
  ctx: LinkContext
): string => {
  if (!rawPath.startsWith("/")) {
    // A raw `<a href>` isn't rewritten, so the browser resolves it against
    // the page's slashless URL: its parent directory, even on an index page.
    return link.raw
      ? resolveRelative(page.route, rawPath, false)
      : relativeTarget(page, rawPath, ctx);
  }
  // A root-relative link naming a content file lands on that file's page,
  // as the Markdown pipeline rewrites it; one naming no file stays as
  // written (a page's Markdown copy, say).
  return link.raw || link.image
    ? rawPath
    : (ctx.rootFileRoute(rawPath) ?? rawPath);
};

/** Classify a single link, queueing external refs via `onExternal`. */
const classifyLink = (
  page: PageRecord,
  link: PageLink,
  ctx: LinkContext,
  onExternal: (ref: ExternalRef) => void
): LinkResult => {
  const { target } = link;
  const site: LinkSite = {
    column: link.column,
    // A link written inside an included partial reports against the partial
    // file, so the author fixes it where it lives.
    file: link.file ?? page.sourcePath ?? page.id,
    line: link.line,
  };

  if (HTTP.test(target) || PROTOCOL_RELATIVE.test(target)) {
    onExternal({
      ...site,
      url: PROTOCOL_RELATIVE.test(target) ? `https:${target}` : target,
    });
    return null;
  }
  const scheme = SCHEME.exec(target)?.[0];
  if (scheme !== undefined) {
    // mailto:, tel:, and other non-HTTP schemes are not validated — except a
    // platform's own, which no browser follows.
    return PLATFORM_SCHEMES.has(scheme.toLowerCase())
      ? {
          ...site,
          code: "BLUME_UNSUPPORTED_LINK_SCHEME",
          message: `Link ${target} uses ReadMe's ${scheme} scheme, which browsers can't follow, so it ships as a dead link.`,
          severity: "warning",
          suggestion: "Link the page by its path instead, like /guides/setup.",
        }
      : null;
  }

  const hashIndex = target.indexOf("#");
  // Browser-copied links arrive percent-encoded (`/caf%C3%A9`, `#caf%C3%A9`)
  // while routes and anchor slugs are stored decoded — decode before comparing
  // so valid links aren't reported broken.
  const fragment = decodePercent(
    hashIndex === -1 ? "" : target.slice(hashIndex + 1)
  );
  let rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const queryIndex = rawPath.indexOf("?");
  if (queryIndex !== -1) {
    rawPath = rawPath.slice(0, queryIndex);
  }
  rawPath = decodePercent(rawPath);

  // A relative path (or a bare anchor) means something different from every
  // including page; an absolute path means the same thing everywhere — so
  // only includer-dependent targets carry the "included by" context, and
  // identical absolute-target reports collapse in the final dedupe.
  const via = rawPath.startsWith("/") ? "" : includedBySuffix(link, page);
  if (rawPath === "") {
    return fragment ? checkAnchor(page.route, fragment, site, ctx, via) : null;
  }

  const resolved = resolveLinkPath(page, link, rawPath, ctx);
  if (link.src) {
    return checkSourceLink(rawPath, resolved, page, link, site, ctx, via);
  }
  return checkPathLink(resolved, fragment, page, link, site, ctx, via);
};

/**
 * Whether an exact redirect target lands somewhere the site serves: a page, a
 * custom or generated route, a `public/` or generated file, or another
 * redirect (a chain, which `blume audit` reports on the built site). `self`
 * is the redirect's own based `from`, which leads nowhere but back.
 */
const redirectLands = (
  path: string,
  self: string,
  ctx: LinkContext
): boolean => {
  const route = toRoute(withBasePath(ctx.basePath, path));
  const redirected =
    ctx.redirects.has(route) ||
    ctx.redirectPatterns.some(
      (from) => pathsUnderPattern(from, [route]).length > 0
    );
  return (
    ctx.routes.has(route) ||
    ctx.extraRoutes.has(route) ||
    (route !== self && redirected) ||
    ctx.servesFile(stripBasePath(ctx.basePath, path))
  );
};

/**
 * Whether anything the site serves sits under a pattern target's literal
 * start (`/guides/` for `/guides/:slug*`): a page, a custom or generated
 * route, a redirect, or a `public/` folder. Which path a capture fills in
 * can't be known before a request, so the prefix is what's checked.
 */
const redirectLandsUnder = (
  prefix: string,
  ctx: LinkContext,
  publicDir: string | null
): boolean => {
  const based = withBasePath(ctx.basePath, prefix);
  const folder = prefix.slice(0, prefix.lastIndexOf("/") + 1);
  return (
    [...ctx.routes, ...ctx.extraRoutes, ...ctx.redirects].some((route) =>
      `${route}/`.startsWith(based)
    ) ||
    (publicDir !== null &&
      statSync(join(publicDir, folder), {
        throwIfNoEntry: false,
      })?.isDirectory() === true)
  );
};

/**
 * Warn about each internal redirect `to` that lands nowhere, located at its
 * `to` in the config file when the redirects are written there. `blume audit`
 * follows redirects through the built site; this catches a dead end before
 * the build. External targets aren't checked.
 */
const redirectTargetDiagnostics = (
  redirects: readonly { from: string; to: string }[],
  ctx: LinkContext,
  options: { configFile?: string; publicDir: string | null }
): Diagnostic[] => {
  const { configFile, publicDir } = options;
  let source: string | undefined;
  return redirects.flatMap((redirect, index): Diagnostic[] => {
    if (!isInternalPath(redirect.to)) {
      return [];
    }
    const path = decodePercent(redirect.to.split(/[?#]/u)[0] ?? "");
    const prefix = destinationPrefix(path);
    const lands =
      prefix === undefined
        ? redirectLands(
            path,
            toRoute(withBasePath(ctx.basePath, redirect.from)),
            ctx
          )
        : redirectLandsUnder(prefix, ctx, publicDir);
    if (lands) {
      return [];
    }
    if (configFile && source === undefined) {
      source = readFileSync(configFile, "utf-8");
    }
    const position = source
      ? locatePath(source, ["redirects", index, "to"])
      : undefined;
    return [
      {
        code: "BLUME_BROKEN_REDIRECT",
        column: position?.column,
        file: configFile,
        line: position?.line,
        message:
          prefix === undefined
            ? `The redirect from ${redirect.from} sends readers to ${redirect.to}, which no page, file, or other redirect serves.`
            : `The redirect from ${redirect.from} sends readers to ${redirect.to}, but nothing is served under ${prefix}.`,
        severity: "warning",
        suggestion: "Point `to` at a page that exists, or remove the redirect.",
      },
    ];
  });
};

/**
 * Validate every link discovered in the content graph: internal page links and
 * anchors against the route map, asset links against the public dir, and
 * (opt-in) external links over the network.
 */
export const validateLinks = async (
  graph: ContentGraph,
  options: {
    /** Site-wide route mount point (`""` or `/seg`); routes and redirects carry it. */
    basePath?: string;
    /**
     * Servable routes the graph can't know: custom `.astro` pages and generated
     * routes (e.g. the `/changelog` index). Mounted outside `basePath` (they're
     * injected at their pattern), so they are *not* based here — mirroring the
     * full-route-set resolution in `nav-diagnostics.ts`/`generateRuntime`.
     */
    extraRoutes?: string[];
    /**
     * The files the build generates beside `public/` (`/llms.txt`,
     * `/sitemap.xml`; see `deploy/generated-files.ts`), base-less: links to
     * them resolve like links to `public/` files.
     */
    generatedFiles?: string[];
    /** Locale routing when i18n is on; links then resolve into the page's locale. */
    i18n?: LocaleRouting | null;
    /** The project's `public/` folder, or `null` when it has none (and so
     * ships no public files). */
    publicDir: string | null;
    checkExternal?: boolean;
    /** External URLs not to request (`--ignore`). Internal links are always checked. */
    ignore?: (url: string) => boolean;
    /**
     * Configured redirects: their `from` paths count as valid link targets,
     * and an internal `to` must land somewhere the site serves.
     */
    redirects?: { from: string; to: string }[];
    /** The config file the redirects are written in, for their positions. */
    configFile?: string;
    /**
     * The `docs` collection's content root, which a root-relative link to a
     * content file (`/guide/new.md`) is read from.
     */
    contentRoot?: string;
    /** `deployment.base` (`""` or `/seg`), which such a link may start with. */
    deployBase?: string;
  }
): Promise<Diagnostic[]> => {
  const basePath = options.basePath ?? "";
  const fileRoutes = buildFileRouteIndex(graph.pages, options.i18n ?? null);
  const { contentRoot } = options;
  const ctx: LinkContext = {
    anchors: buildAnchorIndex(graph.pages),
    basePath,
    extraRoutes: new Set((options.extraRoutes ?? []).map(toRoute)),
    fileRoutes,
    i18n: options.i18n ?? null,
    redirectPatterns: (options.redirects ?? []).flatMap((redirect) =>
      isPatternPath(redirect.from)
        ? [withBasePath(basePath, redirect.from)]
        : []
    ),
    redirects: new Set(
      (options.redirects ?? []).map((redirect) =>
        toRoute(withBasePath(basePath, redirect.from))
      )
    ),
    rootFileRoute: (href) =>
      contentRoot === undefined
        ? undefined
        : resolveRootFileHref(href, {
            contentRoot,
            deployBase: options.deployBase ?? "",
            routeOfFile: (file) => fileRoutes.bySource.get(file),
          }),
    routes: new Set(graph.routes.keys()),
    servesFile: staticFileResolver(options.publicDir, options.generatedFiles),
  };
  const diagnostics: Diagnostic[] = [];
  const external: ExternalRef[] = [];

  for (const page of graph.pages) {
    for (const link of page.links) {
      const result = classifyLink(page, link, ctx, (ref) => external.push(ref));
      if (result) {
        diagnostics.push(result);
      }
    }
  }
  diagnostics.push(
    ...redirectTargetDiagnostics(options.redirects ?? [], ctx, {
      configFile: options.configFile,
      publicDir: options.publicDir,
    })
  );

  // `--ignore` names URLs that can't be checked from where this runs: a
  // placeholder host, a local server, a site that turns bots away.
  const probed = external.filter((ref) => !options.ignore?.(ref.url));
  if (options.checkExternal && probed.length > 0) {
    diagnostics.push(...(await checkExternalLinks(probed)));
  }

  // A partial spliced into several pages (or every locale of one) yields the
  // same diagnostic once per including page record; byte-identical reports
  // add noise without information, so only the first of each survives.
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.code,
      diagnostic.file ?? "",
      diagnostic.line ?? "",
      diagnostic.column ?? "",
      diagnostic.message,
    ].join("\n");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};
