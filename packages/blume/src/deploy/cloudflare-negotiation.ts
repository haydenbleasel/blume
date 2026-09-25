/**
 * `Accept: text/markdown` content negotiation for Cloudflare server builds.
 *
 * Blume prerenders every content page — even in a server build (`deployment:
 * cloudflare()`) — and on Cloudflare the ASSETS binding serves those files before
 * the Worker script runs, so no server-side code (Astro middleware included)
 * ever sees a content-page request. Worse, even a content-page request that
 * does reach the Worker is answered by `@astrojs/cloudflare`'s handler
 * straight from the ASSETS binding, ahead of `app.render` — the only place
 * middleware runs — because `app.match` resolves a prerendered route to
 * nothing and the handler then falls back to the binding.
 *
 * Negotiation therefore needs two coordinated pieces, both applied to the
 * adapter's emitted deploy bundle after `astro build`:
 *
 * 1. `assets.run_worker_first` in `dist/server/wrangler.json`, claiming every
 *    path except the static files that never negotiate, so the platform
 *    routes page requests — and requests for pages that do not exist — to
 *    the Worker instead of serving the static HTML directly (see
 *    `buildRunWorkerFirstRules`).
 * 2. A generated entry Worker that fronts the adapter's: when the client
 *    prefers `text/markdown` it serves the page's prerendered `.md` mirror
 *    from the ASSETS binding, and it delegates everything else to the Astro
 *    Worker untouched.
 *
 * The prerendered per-page JSON documents (`/api/docs/pages/{route}.json`)
 * are the one prerendered surface the adapter's fallback does *not* cover.
 * They come from a prerendered *dynamic* route, and for those Astro's
 * `matchRequest` returns the first non-prerendered route matching the same
 * path — on a server build that is the `/api/[...path]` catch-all, which
 * answers with a 404 problem document; `fallbackToAssets` never runs. The
 * static-pathname endpoints (`pages.json`, `navigation.json`) are unaffected:
 * they sit in the manifest's asset set, which the handler serves from the
 * binding first. So whenever a worker-first rule claims a page JSON URL, the
 * wrapper answers it from the binding itself, keyed by the exact set of
 * documents the build emitted. The generated rule set claims them (a miss
 * must reach the API's `PAGE_NOT_FOUND` answer, see `STATIC_EXEMPTIONS`), and
 * so do user-configured rules or a bare `true`.
 *
 * Cloudflare does not apply `_headers` to worker-first routes, so the wrapper
 * also re-stamps what the static layer would otherwise add on the routes it
 * takes over: the homepage agent-discovery `Link` header, the Markdown
 * `charset=utf-8`, and the sandbox on the SVGs a content source downloaded
 * (see `deploy/headers.ts`). The raw `.md`/`.mdx` URLs are
 * exempted from worker-first routing with negative rules, keeping their
 * `_headers` treatment and their zero-Worker serving path.
 *
 * Configured redirects are baked into the wrapper as well, and answered there
 * with their exact configured status. On a server build Blume routes
 * `redirects` through Astro's own config, and `@astrojs/cloudflare` turns
 * those into `_redirects` entries carrying the exact status — but only
 * Cloudflare's static layer reads that file, and a worker-first route never
 * reaches it. Astro's SSR redirect handler would answer instead, and it honors
 * the configured status only when the destination resolves to a discrete
 * route: Blume serves every page from `[...slug]`, so it never does, and
 * `computeRedirectStatus` defaults a GET to **301** — a permanent redirect
 * that browsers cache indefinitely. The wrapper checking its own redirect
 * table before delegating closes that hole at zero rule cost: unlike negative
 * `run_worker_first` exemptions, a baked-in table spends nothing against
 * Wrangler's 100-rule / 100-character limits, cannot collide with
 * user-configured rules (or a bare `true`), and needs no basing gymnastics —
 * its keys are full served URLs, which is exactly what the Worker sees.
 * Redirects outside every worker-first rule still never invoke the Worker;
 * the static layer serves them from `_redirects` as before.
 *
 * Missing pages negotiate too. Under an explicit `run_worker_first` list the
 * platform answers every request outside the rules from the static layer —
 * an asset miss included, as the nearest `404.html` — which is why the rules
 * claim every path: a request for a URL no page backs then reaches the
 * Worker, and the Astro Worker answers it with the HTML 404 shell from the
 * binding (`not_found_handling: "404-page"`). When the client prefers
 * Markdown the wrapper swaps that shell for the prerendered `/404.md` twin,
 * and when it prefers JSON for the `/404.json` problem document, keeping the
 * 404 status either way — the counterpart of the miss-phase routes in
 * `deploy/vercel-negotiation.ts`. A raw `.md` or `.json` URL no file backs
 * asks for the same twin implicitly, but on this platform such a request only
 * reaches the Worker for `.json` (the generated set keeps `.md` on the static
 * layer for its `_headers`). Only an HTML 404 is swapped, so an API endpoint's
 * own problem document is never overwritten.
 */

import {
  API_NAVIGATION_PATH,
  API_PAGES_PATH,
  OPENAPI_PATH,
} from "../ai/api/paths.ts";
import { normalizeBasePath, normalizePath } from "../core/base-path.ts";
import { CONTENT_ASSETS_ROOT, SVG_ASSET_HEADERS } from "./headers.ts";
import type { NotFoundVariants } from "./vercel-negotiation.ts";

/** Filename of the generated wrapper Worker, next to the adapter's entry. */
export const NEGOTIATION_WORKER_FILE = "blume-worker.mjs";

/**
 * Wrangler's limits on `assets.run_worker_first`: at most 100 rules of at
 * most 100 characters each. A rule set over either limit fails
 * `wrangler deploy` outright, so the injection is skipped instead — only
 * user-configured rules can push the generated set over.
 */
const MAX_RULES = 100;
const MAX_RULE_LENGTH = 100;

/**
 * The paths the generated rules leave on the static layer, relative to the
 * deployment base: the fingerprinted build assets, and the files whose
 * response headers come from `_headers` — which Cloudflare does not apply to
 * a response the Worker produced — and which never negotiate. Those are the
 * raw AI-ready endpoints (`charset=utf-8` on `.md`/`.mdx`/`.txt`) and the
 * `.well-known` discovery documents (the extensionless api-catalog's content
 * type, the CORS headers).
 *
 * The JSON Blume writes at fixed paths stays there too, but JSON as a whole
 * does not: a negative rule outranks every positive one, so a `*.json`
 * exemption would keep a request for a page JSON that doesn't exist
 * (`/api/docs/pages/nope.json`) off the Worker, and the platform would answer
 * it with an empty 404 instead of the API's `PAGE_NOT_FOUND` problem document.
 * The per-page documents themselves reach the wrapper, which serves them from
 * the binding (see the module comment); any other JSON goes through the Astro
 * Worker, which serves a static file from the binding as well.
 */
const STATIC_EXEMPTIONS = [
  "/_astro/*",
  "/*.md",
  "/*.mdx",
  "/*.txt",
  "/.well-known/*",
  "/404.json",
  "/agent-readability.json",
  "/blume-search.json",
  OPENAPI_PATH,
  API_PAGES_PATH,
  API_NAVIGATION_PATH,
];

/** A value as `JSON.parse` produces it (the wrangler config's value space). */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Narrow a parsed JSON value to a plain (non-array) object. */
const isJsonObject = (
  value: JsonValue | undefined
): value is { [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow a parsed JSON value to a string. */
const isJsonString = (value: JsonValue | undefined): value is string =>
  typeof value === "string";

const isNegativeRule = (rule: string): boolean => rule.startsWith("!");

const ruleBody = (rule: string): string =>
  isNegativeRule(rule) ? rule.slice(1) : rule;

/**
 * The `run_worker_first` rules: every path under the deployment base goes
 * through the Worker except the {@link STATIC_EXEMPTIONS}. Claiming
 * everything — rather than only the content routes — is what lets a
 * *missing* page negotiate: under an explicit rule list the platform answers
 * any request outside every rule from the static layer, an asset miss
 * included (as the nearest `404.html`), so a rule set scoped to the content
 * routes would never let the Worker see a request for a URL that has no
 * page. The price is a Worker hop on every page request the site does serve.
 * On a subpath deploy the base is claimed in both request spellings.
 *
 * Configured redirects need no exemption from these rules: the wrapper Worker
 * answers any it claims from its baked-in redirect table with the configured
 * status (see the module comment).
 */
export const buildRunWorkerFirstRules = (base?: string): string[] => {
  const prefix = encodeURI(normalizeBasePath(base));
  const exemptions = STATIC_EXEMPTIONS.map((path) => `!${prefix}${path}`);
  return prefix
    ? [prefix, `${prefix}/*`, ...exemptions]
    : [`/*`, ...exemptions];
};

/**
 * Whether `other` is a same-polarity glob that already covers `rule`.
 * Wrangler's deploy-time validator *rejects* a rule set containing a rule
 * another glob makes redundant, so covered rules must be dropped, not kept.
 */
const coveredBy = (rule: string, other: string): boolean =>
  other !== rule &&
  isNegativeRule(other) === isNegativeRule(rule) &&
  ruleBody(other).endsWith("*") &&
  ruleBody(rule).startsWith(ruleBody(other).slice(0, -1));

/**
 * Merge the generated rules into a user-configured `run_worker_first` (which
 * flows into the adapter's emitted config from the project's own wrangler
 * file). `true` already routes everything through the Worker, so it is kept
 * as-is; an array is unioned with the generated rules and then swept for
 * redundancy, since coverage by a glob is equivalent routing but a hard
 * validation error at deploy time.
 */
export const mergeRunWorkerFirstRules = (
  existing: JsonValue | undefined,
  added: readonly string[]
): string[] | true => {
  if (existing === true) {
    return true;
  }
  const user = Array.isArray(existing)
    ? existing.filter((rule): rule is string => typeof rule === "string")
    : [];
  const merged = [...user, ...added.filter((rule) => !user.includes(rule))];
  return merged.filter(
    (rule) => !merged.some((other) => coveredBy(rule, other))
  );
};

const withinWranglerLimits = (rules: string[] | true): boolean =>
  rules === true ||
  (rules.length <= MAX_RULES &&
    rules.every((rule) => rule.length <= MAX_RULE_LENGTH));

/** A configured redirect the wrapper Worker serves itself. */
export interface WorkerRedirect {
  /**
   * Served path of the redirect, based the way the host platform matches it
   * (see `applyBaseToPlatformRedirects`) — the full URL path the Worker sees.
   */
  from: string;
  /** Configured HTTP status (301, 302, 307, or 308). */
  status: number;
  /** Destination, percent-encoded into the `Location` header. */
  to: string;
}

export interface NegotiationWorkerOptions {
  /** Import specifier of the adapter's built entry, relative to the Worker. */
  mainSpecifier: string;
  /** Content routes with a raw-Markdown mirror (see `markdownRoutePaths`). */
  routePaths: readonly string[];
  /** Name of the assets binding the wrapper serves the `.md` mirrors from. */
  assetsBinding: string;
  /** `deployment.base` for subpath deploys. */
  base?: string;
  /** Homepage agent-discovery `Link` header (see `ai/link-headers.ts`). */
  homeLinkHeader?: string | null;
  /** Estimated token count of the homepage Markdown mirror. */
  homeTokens?: number;
  /** Configured redirects the wrapper answers with their exact status. */
  redirects?: readonly WorkerRedirect[];
  /**
   * Base-less served paths of the prerendered per-page JSON documents the
   * build emitted (see `pageJsonPath`), decoded. The wrapper answers exactly
   * these from the assets binding, since the Astro Worker would route them to
   * the `/api/` catch-all (see the module comment).
   */
  pageJsonPaths?: readonly string[];
  /**
   * Which prerendered 404 twins the build emitted (`404.md`, `404.json`), so
   * the wrapper only substitutes a twin that exists. A project that owns
   * `/404` emits neither and keeps the HTML answer.
   */
  notFound?: NotFoundVariants;
}

/**
 * The wrapper Worker module. The negotiation helpers are a JavaScript copy of
 * `astro/markdown-negotiation.ts` — the deploy bundle is uploaded with
 * `no_bundle`, so the module must be self-contained; behavioral parity with
 * the dev middleware is enforced by `test/cloudflare-negotiation.test.ts`.
 */
export const buildNegotiationWorker = (
  options: NegotiationWorkerOptions
): string => {
  const routes = JSON.stringify(options.routePaths);
  const pageJson = JSON.stringify(options.pageJsonPaths ?? []);
  const binding = JSON.stringify(options.assetsBinding);
  const prefix = JSON.stringify(encodeURI(normalizeBasePath(options.base)));
  const homeLinkHeader = JSON.stringify(options.homeLinkHeader ?? null);
  const homeTokens = JSON.stringify(
    options.homeTokens === undefined ? null : String(options.homeTokens)
  );
  const notFound = JSON.stringify({
    json: options.notFound?.json === true,
    markdown: options.notFound?.markdown === true,
  });
  // Keyed by the normalized served path; the runtime lookup decodes and
  // trims the request path the same way, so both spellings of a URL match.
  // The destination is percent-encoded here because it ships as a `Location`
  // header, which cannot carry non-ASCII.
  const redirects = JSON.stringify(
    Object.fromEntries(
      (options.redirects ?? []).map((redirect) => [
        normalizePath(redirect.from),
        [encodeURI(redirect.to), redirect.status],
      ])
    )
  );
  return `// Generated by Blume. Do not edit; this file is recreated on each build.
//
// Request-time \`Accept: text/markdown\` negotiation for a Cloudflare server
// build. \`assets.run_worker_first\` routes content-page requests here instead
// of the platform's static layer; a client that prefers Markdown gets the
// page's prerendered \`.md\` mirror from the assets binding, a configured
// redirect is answered with its exact configured status, and a prerendered
// per-page JSON document is served from the binding (the Astro Worker would
// route it to the \`/api/\` catch-all, because Astro resolves a prerendered
// dynamic route to the first live route on the same path). Every other
// request is delegated to the Astro Worker untouched — except a missing
// page, whose HTML 404 shell is swapped for the prerendered Markdown or JSON
// 404 twin when the client prefers one. \`_headers\` does not apply to
// worker-first routes, so the homepage Link header, the Markdown charset, and
// the sandbox on downloaded SVGs are re-stamped here.
import server from ${JSON.stringify(options.mainSpecifier)};

const ROUTES = new Set(${routes});
const PAGE_JSON = new Set(${pageJson});
const BASE_PREFIX = ${prefix};
const ASSETS_BINDING = ${binding};
const HOME_LINK_HEADER = ${homeLinkHeader};
const HOME_TOKENS = ${homeTokens};
const REDIRECTS = ${redirects};
const NOT_FOUND = ${notFound};
const SVG_ASSET_HEADERS = ${JSON.stringify(SVG_ASSET_HEADERS)};

// An SVG a content source downloaded: a document that could run script as the
// docs site if opened directly, so it goes out sandboxed. Matched on the
// decoded path, ignoring case — the file the assets binding serves.
const isSvgAsset = (pathname) => {
  const path = safeDecode(pathname).toLowerCase();
  const prefix = (safeDecode(BASE_PREFIX) + "${CONTENT_ASSETS_ROOT}/").toLowerCase();
  return path.startsWith(prefix) && path.endsWith(".svg");
};

// Configured redirects live in \`_redirects\`, which only the static layer
// reads — a worker-first route never reaches it. Answering from this baked-in
// copy keeps the exact configured status; delegating instead would let Astro's
// SSR handler default a GET to a permanent 301.
const redirectFor = (pathname) => {
  const trimmed =
    pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const path = safeDecode(trimmed);
  return Object.hasOwn(REDIRECTS, path) ? REDIRECTS[path] : null;
};

// The request path with the deployment base removed: the whole path on a
// root deploy, \`""\` for the bare base, \`null\` for a path outside the base.
const stripBase = (pathname) => {
  if (!BASE_PREFIX) {
    return pathname;
  }
  if (pathname === BASE_PREFIX) {
    return "";
  }
  return pathname.startsWith(BASE_PREFIX + "/")
    ? pathname.slice(BASE_PREFIX.length)
    : null;
};

// Decoded for the lookups, which are keyed by decoded paths; a malformed
// escape keeps the raw path, which simply won't match anything.
const safeDecode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

// \`_redirects\` semantics, which the static layer applies to these same
// paths: the request's query string is forwarded unless the destination
// carries its own, and a destination fragment stays after the query.
const redirectLocation = (destination, search) => {
  const hashIndex = destination.indexOf("#");
  const bare = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  if (!search || bare.includes("?")) {
    return destination;
  }
  return hashIndex === -1
    ? bare + search
    : bare + search + destination.slice(hashIndex);
};

const parseAccept = (accept) =>
  accept.split(",").map((part) => {
    const segments = part.trim().split(";");
    const type = (segments[0] ?? "").trim().toLowerCase();
    const qSegment = segments
      .slice(1)
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("q="));
    const q = qSegment ? Number(qSegment.slice(2)) : 1;
    return { q: Number.isNaN(q) ? 1 : q, type };
  });

// Whether the client explicitly prefers one of \`types\` over HTML. Browsers
// never send these, so an ordinary page request is false.
const prefers = (accept, types) => {
  if (!accept) {
    return false;
  }
  let wantedQ = -1;
  let htmlQ = 0;
  for (const { q, type } of parseAccept(accept)) {
    if (types.includes(type)) {
      wantedQ = Math.max(wantedQ, q);
    } else if (type === "text/html") {
      htmlQ = Math.max(htmlQ, q);
    }
  }
  return wantedQ > 0 && wantedQ >= htmlQ;
};

const prefersMarkdown = (accept) =>
  prefers(accept, ["text/markdown", "text/x-markdown"]);

const prefersJson = (accept) =>
  prefers(accept, ["application/json", "application/problem+json"]);

// The prerendered 404 twins, in the order a client asking for both is
// answered: which twin, when a client prefers it, the raw URL extension that
// asks for it implicitly, where it lives, and the content type to re-pin.
const NOT_FOUND_TWINS = [
  {
    contentType: "text/markdown; charset=utf-8",
    extension: /\\.mdx?$/u,
    key: "markdown",
    path: "/404.md",
    prefers: prefersMarkdown,
  },
  {
    contentType: "application/problem+json; charset=utf-8",
    extension: /\\.json$/u,
    key: "json",
    path: "/404.json",
    prefers: prefersJson,
  },
];

// A missing page comes back from the Astro Worker as the HTML 404 shell (the
// binding's \`not_found_handling\`); a client that prefers Markdown or JSON —
// or asked for a raw \`.md\`/\`.json\` URL no file backs — gets the prerendered
// twin instead, with the same 404 status. Anything but an HTML 404 (an API
// endpoint's own problem document, a missing image) is left alone. The twin
// is fetched without the request's conditional headers, so a stray ETag match
// cannot turn the 404 into a 304.
const notFoundTwin = async (request, url, response, assets) => {
  if (response.status !== 404 || assets === undefined) {
    return null;
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("text/html")) {
    return null;
  }
  const accept = request.headers.get("accept");
  for (const twin of NOT_FOUND_TWINS) {
    if (!NOT_FOUND[twin.key]) {
      continue;
    }
    const negotiated = twin.prefers(accept);
    if (!negotiated && !twin.extension.test(url.pathname)) {
      continue;
    }
    const asset = await assets.fetch(
      new Request(new URL(BASE_PREFIX + twin.path, url), {
        method: request.method,
      })
    );
    if (!asset.ok) {
      return null;
    }
    const patched = new Response(asset.body, {
      headers: asset.headers,
      status: 404,
    });
    patched.headers.set("content-type", twin.contentType);
    if (negotiated) {
      patched.headers.append("vary", "Accept");
    }
    return patched;
  }
  return null;
};

const markdownVariantUrl = (rawUrl) => {
  const queryIndex = rawUrl.indexOf("?");
  const query = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const rest = stripBase(rawPath);
  if (rest === null) {
    return null;
  }
  const path = rest || "/";
  const trimmed = path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
  const pathname = safeDecode(trimmed);
  if (!ROUTES.has(pathname)) {
    return null;
  }
  const target = pathname === "/" ? "/index" : pathname;
  return BASE_PREFIX + encodeURI(target) + ".md" + query;
};

// Exactly the per-page JSON documents the build emitted, so a URL the site
// never generated (a hidden page, a path outside the API) takes the normal
// route to the Astro Worker and its problem document.
const isPageJson = (pathname) => {
  const rest = stripBase(pathname);
  return rest !== null && PAGE_JSON.has(safeDecode(rest));
};

const isHomePath = (pathname) => {
  const rest = stripBase(pathname);
  return rest === "" || rest === "/";
};

const withHeaders = (response, apply) => {
  const patched = new Response(response.body, response);
  apply(patched.headers);
  return patched;
};

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    // Before the method guard: the static layer applies \`_redirects\` to every
    // method, so the wrapper does too.
    const redirect = redirectFor(url.pathname);
    if (redirect !== null) {
      return new Response(null, {
        headers: { location: redirectLocation(redirect[0], url.search) },
        status: redirect[1],
      });
    }
    if (isSvgAsset(url.pathname)) {
      return withHeaders(await server.fetch(request, env, context), (headers) => {
        for (const [name, value] of Object.entries(SVG_ASSET_HEADERS)) {
          headers.set(name, value);
        }
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return server.fetch(request, env, context);
    }
    const assets = env[ASSETS_BINDING];
    // The request goes through untouched, so a conditional revalidation
    // reaches the binding and comes back as a 304 — anything but a miss is
    // the document's own answer. A miss falls through to the Astro Worker.
    if (assets !== undefined && isPageJson(url.pathname)) {
      const asset = await assets.fetch(request);
      if (asset.status !== 404) {
        return asset;
      }
    }
    const variant = markdownVariantUrl(url.pathname + url.search);
    const home = isHomePath(url.pathname);
    if (
      variant !== null &&
      assets !== undefined &&
      prefersMarkdown(request.headers.get("accept"))
    ) {
      const asset = await assets.fetch(
        new Request(new URL(variant, url), request)
      );
      if (asset.ok) {
        return withHeaders(asset, (headers) => {
          headers.set("content-type", "text/markdown; charset=utf-8");
          headers.append("vary", "Accept");
          if (home) {
            if (HOME_LINK_HEADER !== null) {
              headers.set("link", HOME_LINK_HEADER);
            }
            if (HOME_TOKENS !== null) {
              headers.set("x-markdown-tokens", HOME_TOKENS);
            }
          }
        });
      }
    }
    const response = await server.fetch(request, env, context);
    const twin = await notFoundTwin(request, url, response, assets);
    if (twin !== null) {
      return twin;
    }
    if (variant === null && !(home && HOME_LINK_HEADER !== null)) {
      return response;
    }
    return withHeaders(response, (headers) => {
      if (variant !== null) {
        headers.append("vary", "Accept");
      }
      if (home && HOME_LINK_HEADER !== null && !headers.has("link")) {
        headers.set("link", HOME_LINK_HEADER);
      }
    });
  },
};
`;
};

export interface WorkerNegotiation {
  /** Updated `wrangler.json` text (worker-first rules + swapped `main`). */
  wrangler: string;
  /** The wrapper Worker module, to write as {@link NEGOTIATION_WORKER_FILE}. */
  worker: string;
}

export interface WorkerNegotiationOptions extends Omit<
  NegotiationWorkerOptions,
  "assetsBinding" | "mainSpecifier"
> {
  /**
   * The manifest content routes, based like `routePaths` — the guard that
   * keeps the wrapper's redirect table off real pages. Defaults to
   * `routePaths`, which also carries the synthesized homepage mirror (see
   * `markdownRoutePaths`); passing the manifest routes keeps that synthetic
   * `/` from blocking a configured root redirect.
   */
  contentRoutePaths?: readonly string[];
}

/**
 * Wire the negotiation into the adapter's emitted `dist/server/wrangler.json`:
 * point `main` at the wrapper Worker and scope `assets.run_worker_first` to
 * the content routes (merged with any user-configured rules). Returns the
 * updated config text plus the wrapper module, or `null` when there is
 * nothing to do or nowhere safe to do it: no routes, unparsable config, no
 * usable `main` or assets binding (the wrapper serves the `.md` mirrors from
 * it), an already-swapped `main` (the original entry is unrecoverable), or
 * user-configured rules that push the set over Wrangler's limits.
 *
 * The configured redirects are baked into the wrapper, which answers any the
 * worker-first rules claim with the exact configured status (see the module
 * comment) — whichever rules do the claiming: the generated `/*`, or the
 * user's own (including a bare `true`). A
 * redirect at a content route's own path is never baked: the page owns it,
 * and answering a redirect there would take a real page off the air. When
 * `null` is returned no rule set is written at all, so every request stays on
 * the static layer and `_redirects` serves the configured statuses as before.
 */
export const injectWorkerNegotiation = (
  wranglerText: string,
  options: WorkerNegotiationOptions
): WorkerNegotiation | null => {
  if (options.routePaths.length === 0) {
    return null;
  }
  let config: JsonValue;
  try {
    config = JSON.parse(wranglerText);
  } catch {
    return null;
  }
  if (!isJsonObject(config)) {
    return null;
  }
  const { main } = config;
  if (
    !isJsonString(main) ||
    main.length === 0 ||
    main === NEGOTIATION_WORKER_FILE
  ) {
    return null;
  }
  const { assets } = config;
  if (!isJsonObject(assets) || !isJsonString(assets.binding)) {
    return null;
  }
  const {
    contentRoutePaths = options.routePaths,
    redirects = [],
    ...workerOptions
  } = options;
  // The content-route guard compares against redirect `from`s, which carry the
  // full `{deployment.base}{basePath}` stack; the routes carry only
  // `basePath`, so the deployment base is applied here.
  const deployPrefix = normalizeBasePath(options.base);
  const guardRoutes = new Set(
    contentRoutePaths.map((route) =>
      normalizePath(
        deployPrefix && route !== "/"
          ? `${deployPrefix}${route}`
          : deployPrefix || route
      )
    )
  );
  const workerRedirects = redirects.filter(
    (redirect) =>
      redirect.from.startsWith("/") &&
      !guardRoutes.has(normalizePath(redirect.from))
  );
  const rules = mergeRunWorkerFirstRules(
    assets.run_worker_first,
    buildRunWorkerFirstRules(options.base)
  );
  if (!withinWranglerLimits(rules)) {
    return null;
  }
  if (rules !== true) {
    assets.run_worker_first = rules;
  }
  config.main = NEGOTIATION_WORKER_FILE;
  const mainSpecifier =
    main.startsWith(".") || main.startsWith("/") ? main : `./${main}`;
  const worker = buildNegotiationWorker({
    ...workerOptions,
    assetsBinding: assets.binding,
    mainSpecifier,
    redirects: workerRedirects,
  });
  // The adapter and Wrangler both write this file unformatted; match them.
  return { worker, wrangler: JSON.stringify(config) };
};
