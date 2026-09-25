import {
  normalizeBasePath,
  withAuthoredBasePath,
  withBasePath,
  withComposedBasePath,
} from "../core/base-path.ts";
import { routeSetFor, servesRoute } from "../core/locale-links.ts";
import type { RouteSet } from "../core/locale-links.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { escapeVercelSource } from "./headers.ts";
import type { VercelHeader } from "./headers.ts";

/**
 * Platform redirect files for a static build. Astro already emits redirect HTML
 * (meta-refresh) pages for static output, but that's a soft client redirect.
 * These give the host a real HTTP 3xx: Netlify/Cloudflare read `_redirects`,
 * Vercel reads `vercel.json`, and `blume-redirects.json` is a structured
 * manifest for anything else (Apache/nginx rules, an edge worker).
 */

type Redirect = ResolvedConfig["redirects"][number];

/**
 * Base a redirect destination authored as if mounted at root by what it
 * names (see `withAuthoredBasePath`): a page gains the full
 * `{deployment.base}{basePath}` stack, a public file (`/files/spec.pdf`, with
 * no page in `routes`) only the deployment base — `public/` is served there
 * whatever `basePath` is. External URLs pass through.
 */
const baseRedirectTarget = (
  to: string,
  basePath: string,
  base: string,
  routes: RouteSet
): string =>
  withAuthoredBasePath(base, basePath, to, (route) =>
    servesRoute(routes, route)
  );

/**
 * Base a redirect for Astro's `redirects` config, where the two sides are not
 * symmetric:
 *
 * - `from` gains only `basePath`. Astro builds the match pattern with
 *   `deployment.base` already applied (`getPattern(segments, config.base)`), so
 *   adding it here would serve the redirect at `{base}{base}/from`.
 * - `to` gains the full `{deployment.base}{basePath}` stack, or the deployment
 *   base alone for a public file (see {@link baseRedirectTarget}). Astro
 *   resolves a destination that matches a known route by regenerating it from
 *   that route's segments, which carry no base — and passes an unmatched
 *   destination through verbatim. Neither path prepends `base`, so a
 *   root-relative `to` escapes the base entirely (withastro/astro#7774, still
 *   the behavior in Astro 7).
 *
 * Both sides are authored as if mounted at root; `routes` (the served page
 * routes, carrying `basePath`) tell a dotted page route like `/releases/v1.2`
 * from a file. Idempotent, so a hand-written base isn't doubled.
 */
export const applyBaseToAstroRedirects = (
  redirects: Redirect[],
  basePath: string,
  deployBase: string,
  routes: RouteSet
): Redirect[] => {
  // `deployment.base` arrives as the user wrote it (Astro accepts `/base/`,
  // even `base`); normalizing here keeps the composed paths well-formed.
  const base = normalizeBasePath(deployBase);
  return basePath || base
    ? redirects.map((redirect) => ({
        ...redirect,
        from: withBasePath(basePath, redirect.from),
        to: baseRedirectTarget(redirect.to, basePath, base, routes),
      }))
    : redirects;
};

/**
 * Base a redirect for the host platform files below. Unlike Astro's config,
 * these are matched against the real served URL, so `from` carries the full
 * `{deployment.base}{basePath}` stack, and so does `to` unless it names a
 * public file (see {@link baseRedirectTarget}).
 */
export const applyBaseToPlatformRedirects = (
  redirects: Redirect[],
  basePath: string,
  deployBase: string,
  routes: RouteSet
): Redirect[] => {
  const base = normalizeBasePath(deployBase);
  return basePath || base
    ? redirects.map((redirect) => ({
        ...redirect,
        from: withComposedBasePath(base, basePath, redirect.from),
        to: baseRedirectTarget(redirect.to, basePath, base, routes),
      }))
    : redirects;
};

/**
 * The configured redirects as the host platform matches them, via
 * {@link applyBaseToPlatformRedirects}. The one basing every consumer must
 * share: the emitted redirect files and the Cloudflare worker-first redirect
 * exemptions both compare these paths against real served URLs.
 */
export const platformRedirects = (project: {
  config: ResolvedConfig;
  manifest: Pick<BlumeProject["manifest"], "routes">;
}): Redirect[] => {
  const { config } = project;
  return applyBaseToPlatformRedirects(
    config.redirects,
    config.basePath,
    config.deployment.options.base ?? "",
    routeSetFor(project.manifest.routes)
  );
};

/**
 * `_redirects` text (Netlify + Cloudflare Pages): `from to status` per line.
 * `force` appends Netlify's `!` to each status (`301!`), so the rule wins over
 * the redirect page Astro writes at `from`; Cloudflare, which always applies
 * its rules first, rejects a line carrying it.
 */
export const buildNetlifyRedirects = (
  redirects: Redirect[],
  force = false
): string =>
  `${redirects
    .map(
      (redirect) =>
        `${redirect.from} ${redirect.to} ${redirect.status}${force ? "!" : ""}`
    )
    .join("\n")}\n`;

/** The `vercel.json` Blume writes for a static deploy of `dist/`. */
interface VercelConfig {
  headers?: readonly VercelHeader[];
  redirects: { destination: string; source: string; statusCode: number }[];
}

/**
 * `vercel.json` contents with a `redirects` array, and a `headers` array when
 * header rules are given (see `buildVercelHeaders`). Uses `statusCode` (Vercel's
 * alternative to the boolean `permanent`) so the configured code ships exactly:
 * `permanent` would silently coerce a 301 to 308 and a 302 to 307, diverging
 * from the `_redirects` file, which preserves exact codes. A `source` is a
 * `path-to-regexp` pattern, so each exact `from` path is escaped: unescaped,
 * `/c++-guide` fails the whole config and `/faq(old)` never matches.
 */
export const buildVercelConfig = (
  redirects: Redirect[],
  headers: readonly VercelHeader[] = []
): string => {
  const config: VercelConfig = {
    redirects: redirects.map((redirect) => ({
      destination: redirect.to,
      source: escapeVercelSource(redirect.from),
      statusCode: redirect.status,
    })),
  };
  if (headers.length > 0) {
    config.headers = headers;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
};

/** Structured manifest for hosts that need manual wiring. */
export const buildRedirectManifest = (redirects: Redirect[]): string =>
  `${JSON.stringify(
    redirects.map((redirect) => ({
      from: redirect.from,
      status: redirect.status,
      to: redirect.to,
    })),
    null,
    2
  )}\n`;
