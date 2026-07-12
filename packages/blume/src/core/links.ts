import { existsSync } from "node:fs";

import { basename, join } from "pathe";

import { stripBasePath, withBasePath } from "./base-path.ts";
import { gradeExternal, probeAll } from "./probe.ts";
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
  publicDir: string | null;
  /** Normalized `redirect.from` paths — valid targets that resolve at runtime. */
  redirects: Set<string>;
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
 * recognizes them.
 */
const isIndexPage = (page: PageRecord): boolean =>
  /^index\.(?:md|mdx)$/iu.test(
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

/** Build a map of route -> set of heading anchor slugs. */
const buildAnchorIndex = (pages: PageRecord[]): Map<string, Set<string>> => {
  const anchors = new Map<string, Set<string>>();
  for (const page of pages) {
    anchors.set(
      page.route,
      new Set(page.headings.map((heading) => heading.slug))
    );
  }
  return anchors;
};

/** Verify a fragment resolves to a heading on the target route. */
const checkAnchor = (
  route: string,
  fragment: string,
  site: LinkSite,
  ctx: LinkContext
): Diagnostic | null => {
  if (ctx.anchors.get(route)?.has(fragment.toLowerCase())) {
    return null;
  }
  return {
    ...site,
    code: "BLUME_BROKEN_ANCHOR",
    message: `No heading on ${route} matches anchor #${fragment}.`,
    severity: "warning",
  };
};

/** Validate a resolved internal path: asset, route, then optional anchor. */
const checkPathLink = (
  resolved: string,
  fragment: string,
  target: string,
  site: LinkSite,
  ctx: LinkContext
): LinkResult => {
  // Page routes carry the site-wide base; an absolute author path is written
  // as if mounted at root, so base it for the route lookup (idempotent — a
  // relative link already resolved against the based `page.route`). A real
  // route always wins over the asset-extension heuristic, so a dotted route
  // (e.g. `/releases/v1.0`) isn't misread as a missing asset.
  const route = toRoute(withBasePath(ctx.basePath, resolved));
  if (ctx.routes.has(route)) {
    return fragment ? checkAnchor(route, fragment, site, ctx) : null;
  }
  // A custom `.astro` page or generated route serves this path, but its
  // headings aren't indexed — accept any fragment rather than false-flag it.
  if (ctx.extraRoutes.has(route)) {
    return null;
  }
  // A configured `redirect.from` resolves at runtime, so it's a valid target.
  // Its destination (and any anchor there) is validated on its own page, so we
  // don't follow the redirect to check the fragment here.
  if (ctx.redirects.has(route)) {
    return null;
  }

  // Assets live in `public/` at the site root, unaffected by the base, so strip
  // it back off before probing the filesystem.
  const assetPath = stripBasePath(ctx.basePath, resolved);
  if (FILE_EXT.test(assetPath) && !DOC_EXT.test(assetPath)) {
    if (assetIsPresent(assetPath, ctx)) {
      return null;
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
    message: `Broken link to ${target}: no page resolves to ${route}.`,
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
    file: page.sourcePath ?? page.id,
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

  if (rawPath === "") {
    return fragment ? checkAnchor(page.route, fragment, site, ctx) : null;
  }

  const resolved = rawPath.startsWith("/")
    ? rawPath
    : resolveRelative(page.route, rawPath, isIndexPage(page));
  return checkPathLink(resolved, fragment, target, site, ctx);
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
    publicDir: string | null;
    checkExternal?: boolean;
    /** Configured redirects; their `from` paths count as valid link targets. */
    redirects?: { from: string }[];
  }
): Promise<Diagnostic[]> => {
  const basePath = options.basePath ?? "";
  const ctx: LinkContext = {
    anchors: buildAnchorIndex(graph.pages),
    basePath,
    extraRoutes: new Set((options.extraRoutes ?? []).map(toRoute)),
    publicDir: options.publicDir,
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

  if (options.checkExternal && external.length > 0) {
    diagnostics.push(...(await checkExternalLinks(external)));
  }

  return diagnostics;
};
