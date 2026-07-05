import { existsSync } from "node:fs";

import { basename, join } from "pathe";

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

const EXTERNAL_CONCURRENCY = 8;
const EXTERNAL_TIMEOUT_MS = 10_000;
const STATUS_NOT_FOUND = 404;
const STATUS_GONE = 410;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_NOT_IMPLEMENTED = 501;

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

/**
 * Whether a page is a directory index (`…/index.md(x)`). Its route already *is*
 * its directory, so a relative link must resolve against the route itself, not
 * its parent — otherwise `./sibling` from `guides/index.mdx` (route `/guides`)
 * would resolve to `/sibling` and be falsely flagged as broken.
 */
const isIndexPage = (page: PageRecord): boolean => {
  const ref = page.source?.ref ?? page.sourcePath ?? "";
  return /^index\.(?:md|mdx)$/iu.test(basename(ref));
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
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
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
  // A real route always wins over the asset-extension heuristic, so a path
  // whose last segment merely contains a dot (e.g. a page at `/releases/v1.0`)
  // isn't misread as a missing asset.
  const route = toRoute(resolved);
  if (ctx.routes.has(route)) {
    return fragment ? checkAnchor(route, fragment, site, ctx) : null;
  }
  // A configured `redirect.from` resolves at runtime, so it's a valid target.
  // Its destination (and any anchor there) is validated on its own page, so we
  // don't follow the redirect to check the fragment here.
  if (ctx.redirects.has(route)) {
    return null;
  }

  if (FILE_EXT.test(resolved) && !DOC_EXT.test(resolved)) {
    if (assetIsPresent(resolved, ctx)) {
      return null;
    }
    // Nowhere to look: no `public/` directory.
    if (ctx.publicDir === null) {
      return "asset-unchecked";
    }
    return {
      ...site,
      code: "BLUME_BROKEN_ASSET",
      message: `Asset ${resolved} was not found in the public directory.`,
      severity: "warning",
      suggestion: `Add the file at public${resolved} or fix the link.`,
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

/** Probe a URL with the given method, normalizing failures to a result. */
const request = async (
  url: string,
  method: "GET" | "HEAD"
): Promise<{
  ok: boolean;
  status?: number;
  timedOut?: boolean;
  error?: string;
}> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, timedOut: true };
    }
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Probe a single URL: HEAD first, falling back to GET when needed. */
const probe = async (
  url: string
): Promise<Awaited<ReturnType<typeof request>>> => {
  const head = await request(url, "HEAD");
  const retry =
    head.status === STATUS_METHOD_NOT_ALLOWED ||
    head.status === STATUS_NOT_IMPLEMENTED ||
    (!head.ok && head.status === undefined && !head.timedOut);
  return retry ? await request(url, "GET") : head;
};

/** Grade a probe result into a diagnostic severity + detail, or null if OK. */
const gradeExternal = (
  result: Awaited<ReturnType<typeof request>>
): { severity: Diagnostic["severity"]; detail: string } | null => {
  if (result.ok) {
    return null;
  }
  if (result.timedOut) {
    return { detail: "request timed out", severity: "warning" };
  }
  if (result.status === undefined) {
    return { detail: result.error ?? "unreachable", severity: "error" };
  }
  if (result.status === STATUS_NOT_FOUND || result.status === STATUS_GONE) {
    return { detail: `HTTP ${result.status}`, severity: "error" };
  }
  return { detail: `HTTP ${result.status}`, severity: "warning" };
};

/** Probe queued external links with bounded concurrency. */
const checkExternalLinks = async (
  refs: ExternalRef[]
): Promise<Diagnostic[]> => {
  const unique = [...new Set(refs.map((ref) => ref.url))];
  const results = new Map<string, Awaited<ReturnType<typeof probe>>>();

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const url = unique[cursor];
      cursor += 1;
      if (url !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- bounded-concurrency pool
        results.set(url, await probe(url));
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(EXTERNAL_CONCURRENCY, unique.length) },
      worker
    )
  );

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
    publicDir: string | null;
    checkExternal?: boolean;
    /** Configured redirects; their `from` paths count as valid link targets. */
    redirects?: { from: string }[];
  }
): Promise<Diagnostic[]> => {
  const ctx: LinkContext = {
    anchors: buildAnchorIndex(graph.pages),
    publicDir: options.publicDir,
    redirects: new Set(
      (options.redirects ?? []).map((redirect) => toRoute(redirect.from))
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
