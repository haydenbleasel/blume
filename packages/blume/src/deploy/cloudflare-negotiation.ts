/**
 * `Accept: text/markdown` content negotiation for Cloudflare server builds.
 *
 * Blume prerenders every content page — even under `deployment.output:
 * "server"` — and on Cloudflare the ASSETS binding serves those files before
 * the Worker script runs, so no server-side code (Astro middleware included)
 * ever sees a content-page request. Worse, even a request that does reach the
 * Worker is answered by `@astrojs/cloudflare`'s handler straight from the
 * ASSETS binding, ahead of `app.render` — the only place middleware runs.
 *
 * Negotiation therefore needs two coordinated pieces, both applied to the
 * adapter's emitted deploy bundle after `astro build`:
 *
 * 1. `assets.run_worker_first` in `dist/server/wrangler.json`, scoped to the
 *    content routes so the platform routes their requests to the Worker
 *    instead of serving the static HTML directly (other assets keep their
 *    zero-Worker fast path).
 * 2. A generated entry Worker that fronts the adapter's: when the client
 *    prefers `text/markdown` it serves the page's prerendered `.md` mirror
 *    from the ASSETS binding, and it delegates everything else to the Astro
 *    Worker untouched.
 *
 * Cloudflare does not apply `_headers` to worker-first routes, so the wrapper
 * also re-stamps what the static layer would otherwise add on the routes it
 * takes over: the homepage agent-discovery `Link` header and the Markdown
 * `charset=utf-8` (see `deploy/headers.ts`). The raw `.md`/`.mdx` URLs are
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
 */

import { normalizePath } from "../core/base-path.ts";

/** Filename of the generated wrapper Worker, next to the adapter's entry. */
export const NEGOTIATION_WORKER_FILE = "blume-worker.mjs";

/**
 * Wrangler's limits on `assets.run_worker_first`: at most 100 rules of at
 * most 100 characters each. A rule set over either limit fails
 * `wrangler deploy` outright, so the builder falls back to a coarse set.
 */
const MAX_RULES = 100;
const MAX_RULE_LENGTH = 100;

/**
 * Coarse fallback when the grouped rules would exceed Wrangler's limits:
 * route everything through the Worker except the fingerprinted build assets
 * and the raw AI-ready endpoints, whose `charset=utf-8` comes from `_headers`
 * (not applied on worker-first routes) and whose responses never negotiate.
 */
const FALLBACK_RULES = ["/*", "!/_astro/*", "!/*.md", "!/*.mdx", "!/*.txt"];

/**
 * The deployment base as a rule/URL prefix: trailing slash stripped, empty
 * for a root deploy — the same normalization the dev middleware applies in
 * `astro/markdown-negotiation.ts`.
 */
const basePrefix = (base?: string): string =>
  base && base !== "/" ? base.replace(/\/$/u, "") : "";

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
 * The `run_worker_first` rules for the given content routes: the routes that
 * must reach the Worker for negotiation, grouped by first path segment so the
 * set stays far under Wrangler's 100-rule cap on real sites. Nested groups
 * get a `/{segment}/*` glob plus negative rules exempting their raw
 * `.md`/`.mdx` mirrors; a bare route gets its exact path in both request
 * spellings (with and without the trailing slash) so no unrelated URL pays
 * the Worker hop. On a subpath deploy the whole base is routed as one group —
 * every route lives under it anyway.
 *
 * Configured redirects need no exemption from these rules: the wrapper Worker
 * answers any it claims from its baked-in redirect table with the configured
 * status (see the module comment).
 */
export const buildRunWorkerFirstRules = (
  routePaths: readonly string[],
  base?: string
): string[] => {
  const prefix = encodeURI(basePrefix(base));
  if (prefix) {
    return [
      prefix,
      `${prefix}/*`,
      `!${prefix}/*.md`,
      `!${prefix}/*.mdx`,
      `!${prefix}/*.txt`,
      `!${prefix}/_astro/*`,
    ];
  }
  const groups = new Map<string, { bare: boolean; nested: boolean }>();
  let home = false;
  for (const route of routePaths) {
    if (route === "/") {
      home = true;
      continue;
    }
    const segments = route.split("/").filter(Boolean);
    const head = segments[0] ?? "";
    const group = groups.get(head) ?? { bare: false, nested: false };
    if (segments.length === 1) {
      group.bare = true;
    } else {
      group.nested = true;
    }
    groups.set(head, group);
  }
  const rules: string[] = home ? ["/"] : [];
  const negatives: string[] = [];
  for (const [head, group] of groups) {
    const segment = `/${encodeURI(head)}`;
    if (group.bare) {
      rules.push(segment);
    }
    if (group.nested) {
      rules.push(`${segment}/*`);
      negatives.push(`!${segment}/*.md`, `!${segment}/*.mdx`);
    } else {
      rules.push(`${segment}/`);
    }
  }
  return [...rules, ...negatives];
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
  const binding = JSON.stringify(options.assetsBinding);
  const prefix = JSON.stringify(encodeURI(basePrefix(options.base)));
  const homeLinkHeader = JSON.stringify(options.homeLinkHeader ?? null);
  const homeTokens = JSON.stringify(
    options.homeTokens === undefined ? null : String(options.homeTokens)
  );
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
// redirect is answered with its exact configured status, and every other
// request is delegated to the Astro Worker untouched. \`_headers\` does not
// apply to worker-first routes, so the homepage Link header and the Markdown
// charset are re-stamped here.
import server from ${JSON.stringify(options.mainSpecifier)};

const ROUTES = new Set(${routes});
const BASE_PREFIX = ${prefix};
const ASSETS_BINDING = ${binding};
const HOME_LINK_HEADER = ${homeLinkHeader};
const HOME_TOKENS = ${homeTokens};
const REDIRECTS = ${redirects};

// Configured redirects live in \`_redirects\`, which only the static layer
// reads — a worker-first route never reaches it. Answering from this baked-in
// copy keeps the exact configured status; delegating instead would let Astro's
// SSR handler default a GET to a permanent 301.
const redirectFor = (pathname) => {
  const trimmed =
    pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  let path = trimmed;
  try {
    path = decodeURIComponent(trimmed);
  } catch {
    // Keep the raw path; it simply won't match a configured redirect.
  }
  return Object.hasOwn(REDIRECTS, path) ? REDIRECTS[path] : null;
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

const prefersMarkdown = (accept) => {
  if (!accept) {
    return false;
  }
  let markdownQ = -1;
  let htmlQ = 0;
  for (const { q, type } of parseAccept(accept)) {
    if (type === "text/markdown" || type === "text/x-markdown") {
      markdownQ = Math.max(markdownQ, q);
    } else if (type === "text/html") {
      htmlQ = Math.max(htmlQ, q);
    }
  }
  return markdownQ > 0 && markdownQ >= htmlQ;
};

const markdownVariantUrl = (rawUrl) => {
  const queryIndex = rawUrl.indexOf("?");
  const query = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  let path = rawPath;
  if (BASE_PREFIX) {
    if (path === BASE_PREFIX || path.startsWith(BASE_PREFIX + "/")) {
      path = path.slice(BASE_PREFIX.length) || "/";
    } else {
      return null;
    }
  }
  const trimmed = path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
  let pathname = trimmed;
  try {
    pathname = decodeURIComponent(trimmed);
  } catch {
    // Keep the raw path; it simply won't match a content route.
  }
  if (!ROUTES.has(pathname)) {
    return null;
  }
  const target = pathname === "/" ? "/index" : pathname;
  return BASE_PREFIX + encodeURI(target) + ".md" + query;
};

const isHomePath = (pathname) => {
  let path = pathname;
  if (BASE_PREFIX) {
    if (path !== BASE_PREFIX && !path.startsWith(BASE_PREFIX + "/")) {
      return false;
    }
    path = path.slice(BASE_PREFIX.length);
  }
  return path === "" || path === "/";
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
    if (request.method !== "GET" && request.method !== "HEAD") {
      return server.fetch(request, env, context);
    }
    const variant = markdownVariantUrl(url.pathname + url.search);
    const home = isHomePath(url.pathname);
    const assets = env[ASSETS_BINDING];
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
 * it), an already-swapped `main` (the original entry is unrecoverable), or a
 * rule set that cannot fit Wrangler's limits even after the coarse fallback.
 *
 * The configured redirects are baked into the wrapper, which answers any the
 * worker-first rules claim with the exact configured status (see the module
 * comment) — whichever rules do the claiming: the generated groups, the
 * coarse fallback's `/*`, or the user's own (including a bare `true`). A
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
  const deployPrefix = basePrefix(options.base);
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
  let rules = mergeRunWorkerFirstRules(
    assets.run_worker_first,
    buildRunWorkerFirstRules(options.routePaths, options.base)
  );
  if (!withinWranglerLimits(rules)) {
    rules = mergeRunWorkerFirstRules(assets.run_worker_first, FALLBACK_RULES);
  }
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
