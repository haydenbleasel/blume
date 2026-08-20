/**
 * `Accept: text/markdown` content negotiation for Vercel server builds.
 *
 * Blume prerenders every content page — even under `deployment.output:
 * "server"` — so a page request never reaches Astro middleware: Vercel serves
 * the prerendered HTML straight from its static layer. Request-time negotiation
 * therefore has to live in the platform's routing config. The Vercel adapter
 * emits a Build Output API `config.json`; these helpers splice extra routes
 * into it so a content-page request that prefers `text/markdown` is rewritten
 * (not redirected) to the page's prerendered `.md` mirror — the deployed
 * counterpart of the dev-server rewrite in `astro/markdown-negotiation.ts`.
 */

/**
 * Regex for the `accept` header condition. Written to hold under both matching
 * semantics a router may apply — full-string and substring — by anchoring the
 * end and letting `(.*,)?` absorb any earlier list entries: it requires a
 * `text/markdown` or `text/x-markdown` entry terminated by `;`, `,`, or the end
 * of the header. Kept lookaround-free so it stays valid in RE2, and lowercase
 * only — real agents send lowercase media types, and q-values are not compared
 * (a client sending `text/markdown` at `q=0` is pathological). Browsers never
 * send `text/markdown`, so ordinary page requests are unaffected.
 */
export const ACCEPT_MARKDOWN_HEADER_VALUE =
  "(.*,)?\\s*text/(x-)?markdown(\\s*[;,].*)?$";

/**
 * A Build Output API route — the subset these helpers read and write. Parsed
 * routes keep whatever other fields they carry at runtime; only these are
 * typed.
 */
export interface VercelRoute {
  continue?: boolean;
  dest?: string;
  handle?: string;
  has?: { key?: string; type: string; value?: string }[];
  headers?: Record<string, string>;
  src?: string;
  status?: number;
}

/** Whether a parsed route field is a real string (the config is raw JSON). */
const isString = (value: string | undefined): value is string =>
  typeof value === "string";

const ACCEPT_MARKDOWN_CONDITION: VercelRoute["has"] = [
  { key: "accept", type: "header", value: ACCEPT_MARKDOWN_HEADER_VALUE },
];

const VARY_ACCEPT = { vary: "Accept" };

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
 * many pages, and a count is per-page.
 */
export const buildNegotiationRoutes = (
  routePaths: readonly string[],
  homeTokens?: number
): NegotiationRoutes => {
  const home = routePaths.includes("/");
  const rest = routePaths
    .filter((path) => path !== "/")
    .map((path) => routePattern(path));
  const chunks = chunkPatterns(rest);

  const rewriteRoutes: VercelRoute[] = home
    ? [
        {
          dest: "/index.md",
          has: ACCEPT_MARKDOWN_CONDITION,
          headers:
            homeTokens === undefined
              ? VARY_ACCEPT
              : { ...VARY_ACCEPT, "x-markdown-tokens": String(homeTokens) },
          src: "^/$",
        },
      ]
    : [];
  for (const chunk of chunks) {
    rewriteRoutes.push({
      dest: "$1.md",
      has: ACCEPT_MARKDOWN_CONDITION,
      headers: VARY_ACCEPT,
      src: `^(${chunk.join("|")})/?$`,
    });
  }

  const headerChunks = chunkPatterns(home ? ["/", ...rest] : rest);
  const headerRoutes: VercelRoute[] = headerChunks.map((chunk) => ({
    continue: true,
    headers: VARY_ACCEPT,
    src: `^(?:${chunk.join("|")})/?$`,
  }));

  return { headerRoutes, rewriteRoutes };
};

/** The `src` of the injected homepage `Link` header route. */
const HOME_SRC = "^/$";

/**
 * Permanent redirect from any trailing-slash URL to its slashless twin, so
 * `/docs/` and `/docs` don't serve as duplicate URLs (canonicals, sitemap, and
 * hreflang all use the slashless form; the root `/` is untouched — `.+`
 * requires a non-empty path). Spliced into the main phase before `handle:
 * "filesystem"`, after the Markdown rewrites, so an agent's `Accept:
 * text/markdown` request on a slashed URL still rewrites without the extra
 * hop. Vercel carries the query string over to the `Location` target itself.
 */
export const TRAILING_SLASH_REDIRECT: VercelRoute = {
  headers: { Location: "/$1" },
  src: "^/(.+)/$",
  status: 308,
};

/**
 * Whether a route is one this module previously injected, so re-injection
 * replaces rather than duplicates. Rewrites are identified by their `accept`
 * condition; the `Vary` routes by their exact three-field shape (a
 * user-authored route of that identical shape would be semantically equal to
 * the one re-added); the homepage `Link` route by its three-field
 * continue-with-link shape (the Build Output config is adapter-generated, so
 * no user-authored route competes in this file).
 */
const isNegotiationRoute = (route: VercelRoute): boolean =>
  route.has?.some(
    (condition) => condition.value === ACCEPT_MARKDOWN_HEADER_VALUE
  ) === true ||
  (route.continue === true &&
    route.headers?.vary === "Accept" &&
    isString(route.src) &&
    Object.keys(route).length === 3) ||
  (route.continue === true &&
    isString(route.headers?.link) &&
    route.src === HOME_SRC &&
    Object.keys(route).length === 3) ||
  (route.status === TRAILING_SLASH_REDIRECT.status &&
    route.src === TRAILING_SLASH_REDIRECT.src);

/**
 * Splice the negotiation routes into a Build Output `config.json`, plus — when
 * given — a homepage `Link` header route for agent discovery (see
 * `ai/link-headers.ts`), applied the same way the `Vary` routes are: in the
 * main phase before `handle: "filesystem"` with `continue`, so the header
 * rides on the prerendered homepage response. `contentTypeOverrides` maps static-dir
 * relative paths to media types via the Build Output `overrides` field — the
 * platform's mechanism for extensionless static files (e.g. the Web Bot Auth
 * signature directory). The trailing-slash 308 redirect is always spliced in
 * alongside, so slashed duplicates of every page collapse onto the canonical
 * slashless URL. Returns the updated JSON text (tab-indented, like the
 * adapter's own output), or `null` when there is nowhere safe to splice: an
 * unparsable config, no `routes` array, or no `handle: "filesystem"` marker
 * to anchor the splice.
 */
export const injectNegotiationRoutes = (
  configText: string,
  routePaths: readonly string[],
  homeLinkHeader?: string | null,
  contentTypeOverrides?: Record<string, string>,
  homeTokens?: number
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
  const routes = config.routes.filter((route) => !isNegotiationRoute(route));
  const filesystemIndex = routes.findIndex(
    (route) => route.handle === "filesystem"
  );
  if (filesystemIndex === -1) {
    return null;
  }
  const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes(
    routePaths,
    homeTokens
  );
  if (homeLinkHeader) {
    headerRoutes.push({
      continue: true,
      headers: { link: homeLinkHeader },
      src: HOME_SRC,
    });
  }
  // Headers first: `continue` routes accumulate, so a request the rewrite
  // route then terminates (Markdown negotiation on the homepage) still carries
  // the Link header. The trailing-slash redirect goes last so a slashed URL's
  // Markdown negotiation still rewrites directly instead of bouncing.
  routes.splice(
    filesystemIndex,
    0,
    ...headerRoutes,
    ...rewriteRoutes,
    TRAILING_SLASH_REDIRECT
  );
  config.routes = routes;
  return `${JSON.stringify(config, null, "\t")}\n`;
};
