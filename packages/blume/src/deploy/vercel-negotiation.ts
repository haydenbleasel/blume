/**
 * `Accept: text/markdown` content negotiation for Vercel server builds.
 *
 * Blume prerenders every content page — even in a server build (`deployment:
 * vercel()`) — so a page request never reaches Astro middleware: Vercel serves
 * the prerendered HTML straight from its static layer. Request-time negotiation
 * therefore has to live in the platform's routing config. The Vercel adapter
 * emits a Build Output API `config.json`; these helpers splice extra routes
 * into it so a content-page request that prefers `text/markdown` is rewritten
 * (not redirected) to the page's prerendered `.md` mirror — the deployed
 * counterpart of the dev-server rewrite in `astro/markdown-negotiation.ts`.
 * The same routing config also answers a *missing* page: a request that
 * prefers Markdown (or asks for a `.md` URL no page backs) gets the
 * prerendered Markdown 404 body with the 404 status, instead of the HTML
 * shell, and one that prefers JSON (or asks for a `.json` URL) gets the
 * prerendered problem-details 404.
 *
 * Under `deployment.base` every route here matches the served URL, base
 * included, and names the files where Blume moves them (`static/<base>/`, see
 * {@link rebaseAdapterRoutes}); `base` is the normalized base, `""` for none.
 */

import { mountBasePath } from "../core/base-path.ts";
import { SVG_ASSET_HEADERS } from "./headers.ts";

/*
 * The `accept` header conditions. Dev and the Cloudflare Worker negotiate the
 * way `prefersMarkdown` (`astro/markdown-negotiation.ts`) does: media types in
 * any case, and Markdown only when its q-value is above zero and at least
 * HTML's. A routing condition is a regex over the whole header, with no
 * arithmetic, so the comparison is spelled as two routes per rewrite:
 *
 * - a Markdown entry at full weight (no q-value, or `q=1`) always wins, since
 *   nothing can outrank it;
 * - a Markdown entry below full weight wins only when the header has no
 *   `text/html` entry above zero (a `missing` condition), since two q-values
 *   below 1 can't be compared. That case, like `text/markdown;q=0.9,
 *   text/html;q=0.8`, gets HTML on Vercel where dev and Cloudflare send
 *   Markdown.
 *
 * Every pattern is anchored at both ends and lets `(?:.*,)?` absorb the
 * earlier list entries, so it holds under full-string and substring matching
 * alike. Case-insensitivity is spelled out letter by letter and the patterns
 * are lookaround-free, so they read the same in RE2, PCRE, and JavaScript.
 * Like dev, only the first `q=` parameter of an entry counts, and a `q=`
 * value is read as a decimal. Browsers never send `text/markdown`, so
 * ordinary page requests are unaffected.
 */

/** `word` in any case, one character class per letter: `[Tt][Ee][Xx][Tt]`. */
const anyCase = (word: string): string =>
  word.replaceAll(/[a-z]/gu, (letter) => `[${letter.toUpperCase()}${letter}]`);

/** An entry's parameters before its first `q=`: any that isn't one. */
const OTHER_PARAMS = String.raw`(?:;\s*(?:[^\sq;,][^;,]*|q(?:[^=;,][^;,]*)?)?)*`;

/** Everything after an entry's first `q=` value, up to the next entry. */
const LATER_PARAMS = "(?:;[^,]*)?";

/** A `q=` value of 1 or more: full weight. */
const FULL_WEIGHT = String.raw`0*[1-9][0-9]*(?:\.[0-9]*)?`;

/** A `q=` value above zero and below 1. */
const PARTIAL_WEIGHT = String.raw`0*\.[0-9]*[1-9][0-9]*`;

/** A `q=` value that isn't zero: it has a character besides `0` and `.`. */
const NONZERO_WEIGHT = String.raw`[\s0.]*[^\s0.;,][^;,]*`;

/** A header with an entry of `type` weighed by `weight`, or by no `q=` when it's optional. */
const acceptEntry = (type: string, weight: string, optional: boolean) =>
  String.raw`^(?:.*,)?\s*${type}\s*${OTHER_PARAMS}(?:;\s*q=\s*${weight}\s*${LATER_PARAMS})${optional ? "?" : ""}(?:,.*)?$`;

/** A header with a `type` entry at full weight. */
const fullWeight = (type: string) => acceptEntry(type, FULL_WEIGHT, true);

/** A header with a `type` entry weighed above zero and below 1. */
const partialWeight = (type: string) =>
  acceptEntry(type, PARTIAL_WEIGHT, false);

/** A header with a `text/html` entry weighed above zero. */
const ACCEPT_HTML = acceptEntry(anyCase("text/html"), NONZERO_WEIGHT, true);

const MARKDOWN_TYPE = `${anyCase("text/")}(?:${anyCase("x-")})?${anyCase("markdown")}`;

const JSON_TYPE = `${anyCase("application/")}(?:${anyCase("problem")}\\+)?${anyCase("json")}`;

/** One header condition on a Build Output route. */
export interface VercelCondition {
  key?: string;
  type: string;
  value?: string;
}

/** The conditions of one route: all of `has`, none of `missing`. */
export interface AcceptConditions {
  has: VercelCondition[];
  missing?: VercelCondition[];
}

const accept = (value: string): VercelCondition => ({
  key: "accept",
  type: "header",
  value,
});

/** The pair of conditions a route answering `type` is written once for each. */
const preferring = (type: string): AcceptConditions[] => [
  { has: [accept(fullWeight(type))] },
  { has: [accept(partialWeight(type))], missing: [accept(ACCEPT_HTML)] },
];

/** When a client prefers `text/markdown` (or `text/x-markdown`) over HTML. */
export const ACCEPT_MARKDOWN_CONDITIONS = preferring(MARKDOWN_TYPE);

/**
 * The JSON counterpart, for the problem-details 404: `application/json` or
 * `application/problem+json`. Browsers never send either on a navigation
 * (the catch-all wildcard does not match), so ordinary page requests are
 * unaffected.
 */
export const ACCEPT_JSON_CONDITIONS = preferring(JSON_TYPE);

/**
 * A Build Output API route — the subset these helpers read and write. Parsed
 * routes keep whatever other fields they carry at runtime; only these are
 * typed.
 */
export interface VercelRoute {
  continue?: boolean;
  dest?: string;
  handle?: string;
  has?: VercelCondition[];
  headers?: Record<string, string>;
  missing?: VercelCondition[];
  src?: string;
  status?: number;
}

/** `route` once per condition pair, so it fires when either holds. */
const conditioned = (
  route: VercelRoute,
  conditions: readonly AcceptConditions[]
): VercelRoute[] => conditions.map((condition) => ({ ...route, ...condition }));

/** Whether a parsed route field is a real string (the config is raw JSON). */
const isString = (value: string | undefined): value is string =>
  typeof value === "string";

/** The Markdown conditions' `has` values, to recognize a route this module wrote. */
const MARKDOWN_VALUES = new Set(
  ACCEPT_MARKDOWN_CONDITIONS.flatMap(({ has }) =>
    has.map((condition) => condition.value)
  )
);

const VARY_ACCEPT = { vary: "Accept" };

/** Where the prerendered Markdown 404 (`pages/404.md.ts`) lands. */
const NOT_FOUND_MARKDOWN_DEST = "/404.md";

/** Where the prerendered JSON 404 (`pages/404.json.ts`) lands. */
const NOT_FOUND_JSON_DEST = "/404.json";

/** The adapter's own not-found fallback — the anchor the Markdown 404 precedes. */
const NOT_FOUND_HTML_DEST = "/404.html";

/** Which prerendered 404 twins the build emitted, so their routes get wired. */
export interface NotFoundVariants {
  json?: boolean;
  markdown?: boolean;
}

/**
 * Vercel rejects route `src` patterns longer than 4096 characters, so route
 * alternations are split across as many route entries as needed. The budget
 * leaves headroom for the `^(` … `)/?$` wrapper.
 */
const MAX_ALTERNATION_LENGTH = 3900;

const REGEX_SPECIALS = /[$()*+.?[\]^{|}\\]/gu;

/**
 * A route path as it appears on the wire (percent-encoded, matching the layout
 * of the prerendered files), escaped for literal use inside the alternation.
 * Escaping runs after encoding; the `%` an encode introduces is not a regex
 * metacharacter.
 */
const routePattern = (route: string): string =>
  encodeURI(route).replace(REGEX_SPECIALS, "\\$&");

/**
 * The `src` matching the homepage: `^/$`, or the base itself under one, served
 * without a trailing slash (the adapter's trailing-slash route strips it).
 */
const homeSource = (base: string): string =>
  `^${routePattern(mountBasePath(base, "/"))}$`;

/**
 * Miss-phase routes that answer a missing page with the Markdown 404 body: any
 * path when the client prefers Markdown, and any `.md`/`.mdx` URL (a request
 * for a raw-Markdown mirror that has no page wants Markdown back, not the HTML
 * shell). Both keep the 404 status. Spliced immediately before the adapter's
 * `/404.html` fallback, so they run after every server route (the MCP
 * endpoint, server islands, images) has had its turn and never hijack a
 * request one of those would have answered.
 */
const notFoundMarkdownRoutes = (base: string): VercelRoute[] => {
  const dest = mountBasePath(base, NOT_FOUND_MARKDOWN_DEST);
  const prefix = routePattern(base);
  return [
    ...conditioned(
      { dest, headers: VARY_ACCEPT, src: `^${prefix}/.*$`, status: 404 },
      ACCEPT_MARKDOWN_CONDITIONS
    ),
    { dest, src: `^${prefix}/.*\\.mdx?$`, status: 404 },
  ];
};

/**
 * The JSON 404's miss-phase routes, the problem-details twin of the Markdown
 * ones: any path when the client prefers JSON, and any `.json` URL no file
 * backs. Spliced at the same anchor, after every server route — so the
 * `/api/` catch-all (which answers its own namespace with a problem document)
 * has already had its turn.
 */
const notFoundJsonRoutes = (base: string): VercelRoute[] => {
  const dest = mountBasePath(base, NOT_FOUND_JSON_DEST);
  const prefix = routePattern(base);
  return [
    ...conditioned(
      { dest, headers: VARY_ACCEPT, src: `^${prefix}/.*$`, status: 404 },
      ACCEPT_JSON_CONDITIONS
    ),
    { dest, src: `^${prefix}/.*\\.json$`, status: 404 },
  ];
};

/** Group patterns so each group's alternation stays under the `src` limit. */
const chunkPatterns = (patterns: readonly string[]): string[][] => {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const pattern of patterns) {
    if (
      current.length > 0 &&
      length + pattern.length + 1 > MAX_ALTERNATION_LENGTH
    ) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(pattern);
    length += pattern.length + 1;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

export interface NegotiationRoutes {
  /**
   * `Vary: Accept` for the plain-HTML side of every negotiated URL, so shared
   * caches keep the two variants apart. Spliced *before* `handle:
   * "filesystem"` with `continue`: main-phase headers accumulate and ride on
   * whatever ultimately serves the request. Routes placed after the filesystem
   * marker are the miss phase — they run only when no static file matches, and
   * every Blume content page is a prerendered static file, so a header route
   * there never fires.
   */
  headerRoutes: VercelRoute[];
  /**
   * The negotiation itself: header-conditional rewrites to the `.md` mirror.
   * Spliced *before* `handle: "filesystem"` so they run ahead of static-file
   * matching; the rewritten path then resolves to the prerendered `.md` file.
   */
  rewriteRoutes: VercelRoute[];
}

/**
 * Build the routes for the given content-route paths (the routes that have a
 * raw-Markdown mirror, straight from the manifest). Paths are matched with an
 * optional trailing slash and rewritten `/{route}` → `/{route}.md`; the home
 * page's mirror lives at `/index.md`. When `homeTokens` is given, the home
 * rewrite also stamps `x-markdown-tokens` — the estimated token count of the
 * homepage mirror (Cloudflare's Markdown for Agents convention). Only the home
 * route can carry it: the other rewrites are chunked alternations spanning
 * many pages, and a count is per-page. Under a `base`, each path is matched
 * and rewritten where it's served (`/docs` → `/docs/index.md`).
 */
export const buildNegotiationRoutes = (
  routePaths: readonly string[],
  homeTokens?: number,
  base = ""
): NegotiationRoutes => {
  const home = routePaths.includes("/");
  const rest = routePaths
    .filter((path) => path !== "/")
    .map((path) => routePattern(mountBasePath(base, path)));
  const chunks = chunkPatterns(rest);

  const rewriteRoutes: VercelRoute[] = home
    ? conditioned(
        {
          dest: mountBasePath(base, "/index.md"),
          headers:
            homeTokens === undefined
              ? VARY_ACCEPT
              : { ...VARY_ACCEPT, "x-markdown-tokens": String(homeTokens) },
          src: homeSource(base),
        },
        ACCEPT_MARKDOWN_CONDITIONS
      )
    : [];
  for (const chunk of chunks) {
    rewriteRoutes.push(
      ...conditioned(
        {
          dest: "$1.md",
          headers: VARY_ACCEPT,
          src: `^(${chunk.join("|")})/?$`,
        },
        ACCEPT_MARKDOWN_CONDITIONS
      )
    );
  }

  const headerChunks = chunkPatterns(
    home ? [routePattern(mountBasePath(base, "/")), ...rest] : rest
  );
  const headerRoutes: VercelRoute[] = headerChunks.map((chunk) => ({
    continue: true,
    headers: VARY_ACCEPT,
    src: `^(?:${chunk.join("|")})/?$`,
  }));

  return { headerRoutes, rewriteRoutes };
};

const ALLOW_ANY_ORIGIN = "*";

/**
 * A main-phase `continue` route stamping `Access-Control-Allow-Origin: *` on
 * one static discovery document (see `crossOriginDiscoveryPaths`), so a
 * registry reading it from another origin isn't refused by the browser.
 */
const corsRoute = (path: string, base: string): VercelRoute => ({
  continue: true,
  headers: { "access-control-allow-origin": ALLOW_ANY_ORIGIN },
  src: `^${routePattern(mountBasePath(base, path))}$`,
});

/**
 * The `src` of the route stamping the content-source SVG headers: every `.svg`
 * under `/blume-assets/`.
 */
const svgAssetSource = (base: string): string =>
  String.raw`^${routePattern(base)}/blume-assets/.+\.svg$`;

/**
 * A main-phase `continue` route stamping the sandbox headers
 * (`deploy/headers.ts`) on a downloaded SVG, which Vercel serves from the
 * static layer — where the prerendered asset endpoint's own headers never
 * reach.
 */
const svgAssetRoute = (base: string): VercelRoute => ({
  continue: true,
  headers: Object.fromEntries(
    Object.entries(SVG_ASSET_HEADERS).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ])
  ),
  src: svgAssetSource(base),
});

/** Whether a route is a `corsRoute` — the same three-field shape test as the others. */
const isCorsRoute = (route: VercelRoute): boolean =>
  route.continue === true &&
  route.headers?.["access-control-allow-origin"] === ALLOW_ANY_ORIGIN &&
  isString(route.src) &&
  Object.keys(route).length === 3;

/**
 * Whether a route is one this module previously injected, so re-injection
 * replaces rather than duplicates. Rewrites are identified by their `accept`
 * condition; the `Vary` routes by their exact three-field shape (a
 * user-authored route of that identical shape would be semantically equal to
 * the one re-added); the homepage `Link` route by its three-field
 * continue-with-link shape (the Build Output config is adapter-generated, so
 * no user-authored route competes in this file); the Markdown 404 routes by
 * their `/404.md` destination.
 */
const isNegotiationRoute = (route: VercelRoute, base: string): boolean =>
  route.has?.some((condition) => MARKDOWN_VALUES.has(condition.value)) ===
    true ||
  (route.dest === mountBasePath(base, NOT_FOUND_MARKDOWN_DEST) &&
    route.status === 404) ||
  (route.dest === mountBasePath(base, NOT_FOUND_JSON_DEST) &&
    route.status === 404) ||
  (route.continue === true &&
    route.headers?.vary === "Accept" &&
    isString(route.src) &&
    Object.keys(route).length === 3) ||
  (route.continue === true &&
    isString(route.headers?.link) &&
    route.src === homeSource(base) &&
    Object.keys(route).length === 3) ||
  isCorsRoute(route) ||
  (route.continue === true && route.src === svgAssetSource(base));

/**
 * Splice the negotiation routes into a Build Output `config.json`, plus — when
 * given — a homepage `Link` header route for agent discovery (see
 * `ai/link-headers.ts`), applied the same way the `Vary` routes are: in the
 * main phase before `handle: "filesystem"` with `continue`, so the header
 * rides on the prerendered homepage response. `contentTypeOverrides` maps static-dir
 * relative paths to media types via the Build Output `overrides` field — the
 * platform's mechanism for extensionless static files (e.g. the Web Bot Auth
 * signature directory). The trailing-slash redirect that collapses `/docs/`
 * onto `/docs` is not spliced here: the generated config sets Astro's
 * `trailingSlash: "never"`, which the adapter turns into the platform's own
 * 308 route ahead of everything below (so a slashed Markdown request takes
 * that hop first, then negotiates). For each 404 twin the build emitted (`notFound.markdown` for
 * `404.md`, `notFound.json` for `404.json`), its routes go into the miss
 * phase right before the adapter's `/404.html` fallback — and nowhere when
 * that fallback is absent, since a `dest` with no file behind it would serve
 * nothing. With `svgAssets`, a main-phase route also sandboxes the SVGs a
 * content source downloaded (see {@link svgAssetRoute}). Under a `base`, every
 * route matches and names paths beneath it, and the fallback anchor is the
 * one {@link rebaseAdapterRoutes} moved there. Returns the updated JSON
 * text (tab-indented, like the adapter's own output), or `null` when there is
 * nowhere safe to splice: an unparsable config, no `routes` array, or no
 * `handle: "filesystem"` marker to anchor the splice.
 */
export const injectNegotiationRoutes = (
  configText: string,
  routePaths: readonly string[],
  homeLinkHeader?: string | null,
  contentTypeOverrides?: Record<string, string>,
  homeTokens?: number,
  notFound: NotFoundVariants = {},
  corsPaths: readonly string[] = [],
  svgAssets = false,
  base = ""
): string | null => {
  const overrideEntries = Object.entries(contentTypeOverrides ?? {});
  let config: {
    overrides?: Record<string, { contentType?: string; path?: string }>;
    routes?: VercelRoute[];
  };
  try {
    config = JSON.parse(configText);
  } catch {
    return null;
  }
  if (!Array.isArray(config.routes)) {
    return null;
  }
  for (const [path, contentType] of overrideEntries) {
    // Keyed assignment, so re-injection replaces rather than duplicates and a
    // user's own override of the same path is simply refreshed.
    config.overrides = { ...config.overrides, [path]: { contentType } };
  }
  const routes = config.routes.filter(
    (route) => !isNegotiationRoute(route, base)
  );
  const filesystemIndex = routes.findIndex(
    (route) => route.handle === "filesystem"
  );
  if (filesystemIndex === -1) {
    return null;
  }
  const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes(
    routePaths,
    homeTokens,
    base
  );
  if (homeLinkHeader) {
    headerRoutes.push({
      continue: true,
      headers: { link: homeLinkHeader },
      src: homeSource(base),
    });
  }
  headerRoutes.push(...corsPaths.map((path) => corsRoute(path, base)));
  if (svgAssets) {
    headerRoutes.push(svgAssetRoute(base));
  }
  // Headers first: `continue` routes accumulate, so a request the rewrite
  // route then terminates (Markdown negotiation on the homepage) still carries
  // the Link header.
  routes.splice(filesystemIndex, 0, ...headerRoutes, ...rewriteRoutes);
  const notFoundRoutes = [
    ...(notFound.markdown ? notFoundMarkdownRoutes(base) : []),
    ...(notFound.json ? notFoundJsonRoutes(base) : []),
  ];
  if (notFoundRoutes.length > 0) {
    const fallbackDest = mountBasePath(base, NOT_FOUND_HTML_DEST);
    const fallbackIndex = routes.findIndex(
      (route) => route.status === 404 && route.dest === fallbackDest
    );
    if (fallbackIndex !== -1) {
      routes.splice(fallbackIndex, 0, ...notFoundRoutes);
    }
  }
  config.routes = routes;
  return `${JSON.stringify(config, null, "\t")}\n`;
};

/**
 * Splice routes for the pattern redirects (see `vercelPatternRoutes`) into a
 * Build Output `config.json`, in the main phase just ahead of
 * `handle: "filesystem"`: after the exact redirects the adapter puts first,
 * so an exact path still wins. A second pass replaces its own routes. Returns
 * the updated JSON text, or `null` when there is nowhere safe to splice: an
 * unparsable config, no `routes` array, or no `handle: "filesystem"` marker.
 */
export const injectRedirectRoutes = (
  configText: string,
  redirectRoutes: readonly VercelRoute[]
): string | null => {
  let config: { routes?: VercelRoute[] };
  try {
    config = JSON.parse(configText);
  } catch {
    return null;
  }
  if (!Array.isArray(config.routes)) {
    return null;
  }
  const ours = new Set(redirectRoutes.map((route) => route.src));
  const routes = config.routes.filter(
    (route) => !(ours.has(route.src) && isString(route.headers?.Location))
  );
  const filesystemIndex = routes.findIndex(
    (route) => route.handle === "filesystem"
  );
  if (filesystemIndex === -1) {
    return null;
  }
  routes.splice(filesystemIndex, 0, ...redirectRoutes);
  config.routes = routes;
  return `${JSON.stringify(config, null, "\t")}\n`;
};

/**
 * The trailing-slash route `trailingSlash: "never"` gives the adapter's config
 * (`^/(.*)/$` → `/$1`): it keeps whatever path it strips the slash from, base
 * and all, so it already serves a based site.
 */
const isTrailingSlashRoute = (route: VercelRoute): boolean =>
  route.headers?.Location === "/$1";

/** The pattern body of the root route, anchored (`^/$`) or not (`/`). */
const ROOT_BODY = /^\/\$?$/u;

/**
 * Re-anchor an adapter route pattern under the base, whose escaped form is
 * `prefix`: each matches a base-less path from its start, and the root route
 * becomes the base itself, served without a trailing slash.
 */
const rebaseSource = (src: string, prefix: string): string => {
  const body = src.startsWith("^") ? src.slice(1) : src;
  return `^${prefix}${ROOT_BODY.test(body) ? "$" : body}`;
};

/**
 * Move the adapter's routes under `deployment.base`, to match the static files
 * Blume moves to `static/<base>/`. `@astrojs/vercel` routes a server build as
 * if it were served from the root: its route patterns (the `_astro/` cache
 * header, every server route) match base-less paths, its 404 fallback names
 * `/404.html`, and it joins the base onto each redirect with no slash on the
 * `from` side and a second time on the `to` side, which Astro hands it
 * already based (`^/docsold$` → `/docs/docs/new`). Each pattern is
 * re-anchored under the base and the fallback names the base's `404.html`;
 * the adapter's redirects make way for `redirectRoutes`, the exact redirects
 * as the host matches them. Returns the updated JSON text, or `null` when
 * there is nowhere safe to splice: an unparsable config, no `routes` array,
 * or no `handle: "filesystem"` marker.
 */
export const rebaseAdapterRoutes = (
  configText: string,
  base: string,
  redirectRoutes: readonly VercelRoute[]
): string | null => {
  let config: { routes?: VercelRoute[] };
  try {
    config = JSON.parse(configText);
  } catch {
    return null;
  }
  if (!Array.isArray(config.routes)) {
    return null;
  }
  const filesystemIndex = config.routes.findIndex(
    (route) => route.handle === "filesystem"
  );
  if (filesystemIndex === -1) {
    return null;
  }
  const prefix = routePattern(base);
  const routes = config.routes.flatMap((route, index): VercelRoute[] => {
    // Ahead of the filesystem handler, the adapter writes its redirects and
    // nothing else with a `Location`.
    if (index < filesystemIndex && isString(route.headers?.Location)) {
      return isTrailingSlashRoute(route) ? [route] : [];
    }
    const rebased = { ...route };
    if (isString(route.src)) {
      rebased.src = rebaseSource(route.src, prefix);
    }
    if (route.status === 404 && route.dest === NOT_FOUND_HTML_DEST) {
      rebased.dest = mountBasePath(base, NOT_FOUND_HTML_DEST);
    }
    return [rebased];
  });
  routes.splice(
    routes.findIndex((route) => route.handle === "filesystem"),
    0,
    ...redirectRoutes
  );
  config.routes = routes;
  return `${JSON.stringify(config, null, "\t")}\n`;
};
