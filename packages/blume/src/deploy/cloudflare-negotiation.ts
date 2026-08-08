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
 * Configured redirects need the same exemption, for a sharper reason. `_headers`
 * is cosmetic on a worker-first route; `_redirects` is the *only* thing that
 * serves a redirect with its configured status. On a server build Blume routes
 * `redirects` through Astro's own config, and `@astrojs/cloudflare` turns those
 * into `_redirects` entries carrying the exact status — a file the static layer
 * reads and a worker-first route never reaches. Astro's SSR redirect handler
 * then answers instead, and it honors the configured status only when the
 * destination resolves to a discrete route: Blume serves every page from
 * `[...slug]`, so it never does, and `computeRedirectStatus` defaults a GET to
 * **301**. A configured 302 swallowed by a content group therefore ships as a
 * permanent redirect that browsers cache indefinitely. Every redirect a
 * positive rule would claim is excluded here so the static layer keeps it.
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

/**
 * Whether a `run_worker_first` rule claims a served path, following
 * Cloudflare's glob semantics: a trailing `*` is a prefix match, anything else
 * matches the path exactly.
 */
const ruleClaims = (rule: string, path: string): boolean =>
  rule.endsWith("*") ? path.startsWith(rule.slice(0, -1)) : rule === path;

const isNegativeRule = (rule: string): boolean => rule.startsWith("!");

const ruleBody = (rule: string): string =>
  isNegativeRule(rule) ? rule.slice(1) : rule;

/**
 * Fit each exemption under Wrangler's per-rule length cap. An over-long rule
 * collapses to the glob of its longest ancestor whose rule fits — but only
 * when no content route lives at or under that ancestor, since the glob would
 * take the route off the Worker and silently disable its negotiation. With no
 * safe ancestor the over-long rule is kept, so the caller's limits check skips
 * the negotiation instead of shipping the redirect as a permanent 301 (see
 * `injectWorkerNegotiation` on that ordering) — but one pathological path no
 * longer costs the whole site its negotiation when a safe glob exists.
 */
const fitExemptions = (
  rules: readonly string[],
  routes: readonly string[]
): string[] => {
  const fitted = rules.map((rule) => {
    if (rule.length <= MAX_RULE_LENGTH) {
      return rule;
    }
    const path = ruleBody(rule).replace(/\/\*?$/u, "");
    for (
      let cut = path.lastIndexOf("/");
      cut > 0;
      cut = path.lastIndexOf("/", cut - 1)
    ) {
      const ancestor = path.slice(0, cut);
      if (`!${ancestor}/*`.length > MAX_RULE_LENGTH) {
        continue;
      }
      // A shorter ancestor's glob covers everything this one does, so a
      // shadowed first candidate ends the search.
      return routes.some(
        (route) => route === ancestor || route.startsWith(`${ancestor}/`)
      )
        ? rule
        : `!${ancestor}/*`;
    }
    return rule;
  });
  return [...new Set(fitted)];
};

/**
 * Negative rules exempting the configured redirects that `positives` would
 * otherwise claim, so Cloudflare's static layer keeps serving them from
 * `_redirects` with their configured status (see the module comment).
 *
 * A redirect that no positive rule claims gets no rule at all — it is already
 * on the static layer, and every rule spent here counts against Wrangler's cap
 * of 100. For the same reason a claimed redirect is exempted only in the
 * request spellings (with and without the trailing slash) a positive actually
 * claims. A path that is also a content route is never exempted: the page owns
 * it, and taking it off the Worker would silently disable its negotiation.
 *
 * A redirect that is itself the parent of other redirects collapses to a
 * `{path}` + `{path}/*` pair, which is two rules however many URLs the retired
 * section held — but only when no content route lives underneath, since the
 * glob would take that route off the Worker too.
 *
 * `routePaths` must be based the same way `redirectPaths` are — on a subpath
 * deploy both sides carry the full `{deployment.base}{basePath}` stack, or the
 * content-route guards silently compare disjoint namespaces.
 */
const redirectExemptions = (
  redirectPaths: readonly string[],
  routePaths: readonly string[],
  positives: readonly string[]
): string[] => {
  const routes = [
    ...new Set(routePaths.map((route) => encodeURI(normalizePath(route)))),
  ];
  const routeSet = new Set(routes);
  const claimsBare = (path: string): boolean =>
    positives.some((rule) => ruleClaims(rule, path));
  const claimsSlashed = (path: string): boolean =>
    positives.some((rule) => ruleClaims(rule, `${path}/`));
  const claimed = [
    ...new Set(
      redirectPaths
        .map((path) => encodeURI(normalizePath(path)))
        .filter(
          (path) =>
            path.startsWith("/") &&
            !routeSet.has(path) &&
            (claimsBare(path) || claimsSlashed(path))
        )
    ),
    // Shortest first, so an outer redirect collapses its own descendants.
  ].toSorted();
  const rules: string[] = [];
  const absorbed = new Set<string>();
  for (const path of claimed) {
    if (absorbed.has(path)) {
      continue;
    }
    if (path === "/") {
      // `!//` is malformed and `!/*` would exempt the whole site.
      rules.push("!/");
      continue;
    }
    const nested = claimed.filter((other) => other.startsWith(`${path}/`));
    if (
      nested.length > 0 &&
      !routes.some((route) => route.startsWith(`${path}/`))
    ) {
      for (const other of nested) {
        absorbed.add(other);
      }
      if (claimsBare(path)) {
        rules.push(`!${path}`);
      }
      rules.push(`!${path}/*`);
      continue;
    }
    if (claimsBare(path)) {
      rules.push(`!${path}`);
    }
    if (claimsSlashed(path)) {
      rules.push(`!${path}/`);
    }
  }
  return fitExemptions(rules, routes);
};

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
 * Redirect exemptions are not emitted here: `injectWorkerNegotiation` derives
 * them from the *merged* rule set, so redirects claimed by user-configured
 * rules are exempted exactly like ones claimed by these.
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
  existing: unknown,
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
  return `// Generated by Blume. Do not edit; this file is recreated on each build.
//
// Request-time \`Accept: text/markdown\` negotiation for a Cloudflare server
// build. \`assets.run_worker_first\` routes content-page requests here instead
// of the platform's static layer; a client that prefers Markdown gets the
// page's prerendered \`.md\` mirror from the assets binding, and every other
// request is delegated to the Astro Worker untouched. \`_headers\` does not
// apply to worker-first routes, so the homepage Link header and the Markdown
// charset are re-stamped here.
import server from ${JSON.stringify(options.mainSpecifier)};

const ROUTES = new Set(${routes});
const BASE_PREFIX = ${prefix};
const ASSETS_BINDING = ${binding};
const HOME_LINK_HEADER = ${homeLinkHeader};
const HOME_TOKENS = ${homeTokens};

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
    if (request.method !== "GET" && request.method !== "HEAD") {
      return server.fetch(request, env, context);
    }
    const url = new URL(request.url);
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
   * Served paths of the configured redirects, based the way the host platform
   * matches them (see `applyBaseToPlatformRedirects`). Exempted from
   * worker-first routing so they keep their configured status.
   */
  redirectPaths?: readonly string[];
  /**
   * The manifest content routes, based like `routePaths` — the guard that
   * keeps redirect exemptions off real pages. Defaults to `routePaths`, which
   * also carries the synthesized homepage mirror (see `markdownRoutePaths`);
   * passing the manifest routes keeps that synthetic `/` from blocking the
   * exemption of a configured root redirect.
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
 * The redirect exemptions are derived from the *merged* rule set — the user's
 * own `run_worker_first` rules claim a redirect exactly like the generated
 * ones, and a user's `true` (rewritten to its array spelling `/*` so the
 * negatives can ride along) claims everything. They also ride along into the
 * coarse fallback, where they matter more rather than less: `/*` claims every
 * path, so without them every configured redirect would lose its status. If
 * even that set cannot fit, the negotiation is skipped entirely. That ordering
 * is deliberate — a redirect served as a permanent 301 is a cached,
 * user-visible defect, while skipping negotiation only means the raw Markdown
 * stays at its explicit `.md` URL.
 */
export const injectWorkerNegotiation = (
  wranglerText: string,
  options: WorkerNegotiationOptions
): WorkerNegotiation | null => {
  if (options.routePaths.length === 0) {
    return null;
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(wranglerText);
  } catch {
    return null;
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const { main } = config;
  if (
    typeof main !== "string" ||
    main.length === 0 ||
    main === NEGOTIATION_WORKER_FILE
  ) {
    return null;
  }
  const assets = config.assets as Record<string, unknown> | undefined;
  if (
    assets === null ||
    typeof assets !== "object" ||
    typeof assets.binding !== "string"
  ) {
    return null;
  }
  const {
    contentRoutePaths = options.routePaths,
    redirectPaths = [],
    ...workerOptions
  } = options;
  // The exemption guards compare content routes against `redirectPaths`, which
  // carry the full `{deployment.base}{basePath}` stack; the routes carry only
  // `basePath`, so the deployment base is applied here.
  const deployPrefix = basePrefix(options.base);
  const guardRoutes = deployPrefix
    ? contentRoutePaths.map((route) =>
        route === "/" ? deployPrefix : `${deployPrefix}${route}`
      )
    : contentRoutePaths;
  const withRedirectExemptions = (merged: string[] | true): string[] | true => {
    const positives =
      merged === true ? ["/*"] : merged.filter((rule) => !isNegativeRule(rule));
    const exemptions = redirectExemptions(
      redirectPaths,
      guardRoutes,
      positives
    );
    return exemptions.length === 0
      ? merged
      : mergeRunWorkerFirstRules(merged === true ? ["/*"] : merged, exemptions);
  };
  let rules = withRedirectExemptions(
    mergeRunWorkerFirstRules(
      assets.run_worker_first,
      buildRunWorkerFirstRules(options.routePaths, options.base)
    )
  );
  if (!withinWranglerLimits(rules)) {
    rules = withRedirectExemptions(
      mergeRunWorkerFirstRules(assets.run_worker_first, FALLBACK_RULES)
    );
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
  });
  // The adapter and Wrangler both write this file unformatted; match them.
  return { worker, wrangler: JSON.stringify(config) };
};
