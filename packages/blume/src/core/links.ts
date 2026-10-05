import { existsSync } from "node:fs";

import { basename, dirname, join, normalize, relative, resolve } from "pathe";

import { stripBasePath, withBasePath } from "./base-path.ts";
import {
  isRelativeImageTarget,
  resolveRelativeImage,
} from "./content-assets.ts";
import type { LocaleRouting } from "./i18n.ts";
import { localizeLinkPath } from "./locale-links.ts";
import { gradeExternal, probeAll } from "./probe.ts";
import { isPatternPath, pathsUnderPattern } from "./redirect-patterns.ts";
import type {
  ContentGraph,
  Diagnostic,
  PageLink,
  PageRecord,
} from "./types.ts";

const HTTP = /^https?:\/\//iu;
const PROTOCOL_RELATIVE = /^\/\//u;
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

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
  /** Servable routes outside the graph (custom pages, generated routes); their
   * headings are unknown, so anchors there are accepted unchecked. */
  extraRoutes: Set<string>;
  /** Where content files publish, for file links (`./setup.mdx`). */
  fileRoutes: FileRouteIndex;
  /** Locale routing, when the site is multi-locale; drives served-route resolution. */
  i18n: LocaleRouting | null;
  publicDir: string | null;
  /** Normalized `redirect.from` paths — valid targets that resolve at runtime. */
  redirects: Set<string>;
  /** Pattern `redirect.from`s (`/beta/:slug*`), based like `redirects`. */
  redirectPatterns: string[];
  routes: Set<string>;
}

/** Whether a resolved asset path exists under `public/`. */
const assetIsPresent = (resolved: string, ctx: LinkContext): boolean =>
  ctx.publicDir !== null && existsSync(join(ctx.publicDir, resolved));

/** Outcome of classifying one link target. */
type LinkResult = Diagnostic | "asset-unchecked" | null;

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
 * lands on its page instead of on its raw Markdown source. Without
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
  const fileRoute = DOC_EXT.test(path)
    ? resolveFile?.(decodePercent(path))
    : undefined;
  return `${fileRoute ?? toRoute(resolveRelative(from.route, path, from.isIndex))}${suffix}`;
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
  // it back off before probing the filesystem.
  const assetPath = stripBasePath(ctx.basePath, resolved);
  if (FILE_EXT.test(assetPath) && !DOC_EXT.test(assetPath)) {
    if (assetIsPresent(assetPath, ctx)) {
      return null;
    }
    // A colocated image embed (`![](./diagram.png)`) is resolved from beside
    // the page source and emitted to `_astro/` by the image pipeline, so it
    // never lands in `public/`. The *raw* target goes through the same
    // resolver that decides what the `/blume-assets/content` endpoint serves,
    // so a reference the rewriter skips (a `?v=2` suffix, a double-encoded
    // name) is reported here, not accepted. Plain links to the same path stay
    // on the public-dir probe — an href resolves as a site route, and only
    // image nodes are rewritten.
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
        suggestion:
          "Add the file next to the page source or fix the reference.",
      };
    }
    // Nowhere to look: no `public/` directory.
    if (ctx.publicDir === null) {
      return "asset-unchecked";
    }
    return {
      ...site,
      code: "BLUME_BROKEN_ASSET",
      message: `Asset ${assetPath} was not found in the public directory.`,
      severity: "warning",
      suggestion: `Add the file at public${assetPath} or fix the link.`,
    };
  }

  return {
    ...site,
    code: "BLUME_BROKEN_LINK",
    message: `Broken link to ${link.target}${via}: no page resolves to ${route}.`,
    severity: "error",
    suggestion: "Check the path, or create the target page.",
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
    resolveFile = (path) =>
      ctx.fileRoutes.byEntryId.get(normalize(join(dirname(entryId), path)));
  }
  return (
    resolveRelativeHref(rawPath, base, resolveFile, (route) =>
      ctx.routes.has(route)
    ) ?? resolveRelative(page.route, rawPath, base.isIndex)
  );
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
  if (SCHEME.test(target)) {
    // mailto:, tel:, and other non-HTTP schemes are not validated.
    return null;
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

  let resolved = rawPath;
  if (!rawPath.startsWith("/")) {
    // A raw `<a href>` isn't rewritten, so the browser resolves it against
    // the page's slashless URL: its parent directory, even on an index page.
    resolved = link.raw
      ? resolveRelative(page.route, rawPath, false)
      : relativeTarget(page, rawPath, ctx);
  }
  return checkPathLink(resolved, fragment, page, link, site, ctx, via);
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
    /** Locale routing when i18n is on; links then resolve into the page's locale. */
    i18n?: LocaleRouting | null;
    publicDir: string | null;
    checkExternal?: boolean;
    /** External URLs not to request (`--ignore`). Internal links are always checked. */
    ignore?: (url: string) => boolean;
    /** Configured redirects; their `from` paths count as valid link targets. */
    redirects?: { from: string }[];
  }
): Promise<Diagnostic[]> => {
  const basePath = options.basePath ?? "";
  const ctx: LinkContext = {
    anchors: buildAnchorIndex(graph.pages),
    basePath,
    extraRoutes: new Set((options.extraRoutes ?? []).map(toRoute)),
    fileRoutes: buildFileRouteIndex(graph.pages, options.i18n ?? null),
    i18n: options.i18n ?? null,
    publicDir: options.publicDir,
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
    routes: new Set(graph.routes.keys()),
  };
  const diagnostics: Diagnostic[] = [];
  const external: ExternalRef[] = [];
  let uncheckedAssets = 0;

  for (const page of graph.pages) {
    for (const link of page.links) {
      const result = classifyLink(page, link, ctx, (ref) => external.push(ref));
      if (result === "asset-unchecked") {
        uncheckedAssets += 1;
      } else if (result) {
        diagnostics.push(result);
      }
    }
  }

  if (uncheckedAssets > 0) {
    diagnostics.push({
      code: "BLUME_ASSETS_UNCHECKED",
      message: `${uncheckedAssets} asset link(s) not checked: no public/ directory found.`,
      severity: "info",
    });
  }

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
