import { normalizePath, stripBasePath } from "../core/base-path.ts";
import type { AuditContext } from "./types.ts";

// Re-exported from its home next to the other path helpers; the audit checks
// (and their tests) import it from here.
export { normalizePath } from "../core/base-path.ts";

/** The slice of an audit context that says what the build serves. */
export type ServedContext = Pick<AuditContext, "byUrl" | "files" | "project">;

/**
 * Routes the server answers that the build writes no file for.
 *
 * The MCP endpoint is streamable HTTP: llms.txt advertises `agents.mcp.route`
 * whenever the server is enabled, but it appears in neither the page snapshots
 * nor the static file index, so a check that only consults those reads the
 * site's own index as broken. The exemption is the configured route while the
 * server is on, and nothing wider — with `agents.mcp` off, a listed `/mcp` is as
 * dead as any other missing target. Any future server route (a search API, a
 * playground proxy) belongs here too, so every check recognizes it at once.
 */
const serverRoutes = (context: ServedContext): string[] => {
  const mcp = context.project.config.agents?.mcp;
  return mcp?.enabled ? [normalizePath(mcp.route)] : [];
};

/**
 * Whether a normalized path is served by the build — as a page, as a static
 * file, or as a route the server answers. The one definition of "served" for
 * the link, llms.txt, and redirect checks, so they can never disagree about
 * the same target.
 */
export const isServed = (context: ServedContext, path: string): boolean =>
  context.byUrl.has(path) ||
  context.files.has(path) ||
  // Astro's directory format serves `/docs/api` from `/docs/api/index.html`.
  context.files.has(`${path}/index.html`) ||
  serverRoutes(context).includes(path);

/** What an `href` in built HTML turned out to point at. */
export type ResolvedHref =
  /** A path on this site. */
  | { kind: "internal"; path: string; hash: string }
  /** An absolute URL that resolves back to this site — should have been a path. */
  | { kind: "self-origin"; path: string; hash: string }
  /**
   * A path on this origin that lacks `deployment.base`. The host serves the
   * whole build under the base, so nothing in the build answers here — `path`
   * is the path as requested, base missing. `absolute` when the href spelled
   * out the origin: a full URL can name another app on the same host.
   */
  | { kind: "outside-base"; path: string; absolute: boolean }
  /** An absolute URL on another origin. */
  | { kind: "external"; url: string }
  /** In-page anchor, `mailto:`, `tel:`, `javascript:`, data URI — not a page link. */
  | { kind: "ignored" };

/** Whether a served path sits under the deployment base (always, without one). */
const underBase = (deployBase: string, path: string): boolean =>
  !deployBase || path === deployBase || path.startsWith(`${deployBase}/`);

const NON_HTTP_SCHEME = /^(?!https?:)[a-z][a-z0-9+.-]*:/iu;

/**
 * Percent-decode a pathname for comparison against the built file tree. Page
 * URLs and file-index keys come from raw on-disk names, while `URL#pathname`
 * (and the `encodeURI`'d sitemap `<loc>`s) are percent-encoded — a Japanese
 * route would never match its own page without this. Malformed sequences are
 * kept as-is: they can't have come from our own encoder.
 */
export const decodePath = (path: string): string => {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};

/**
 * Whether a `--url` value is an absolute http(s) URL the network tier can
 * probe. A bare host (`example.com`) has no scheme, and `localhost:4321`
 * parses with `localhost:` as its scheme — both are rejected.
 */
export const isHttpUrl = (input: string): boolean => {
  try {
    const { protocol } = new URL(input);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** The origin of `deployment.site`, or null when no site is configured. */
export const siteOrigin = (site?: string): string | null => {
  if (!site) {
    return null;
  }
  try {
    return new URL(site).origin;
  } catch {
    return null;
  }
};

/**
 * Resolve an `href` found on `pageUrl` into something the link graph can use.
 *
 * An absolute URL pointing back at our own origin is reported separately from a
 * genuine external link: it's an internal link that hardcoded the production
 * domain, which silently breaks on preview deploys and under `basePath`.
 *
 * `deployBase` is the normalized `deployment.base`: emitted hrefs carry it, but
 * the built file tree (and so every page URL and file-index key) does not, so it
 * is stripped here to keep resolved paths comparable. `basePath` is different —
 * Blume mounts it as a real directory in the build, so it stays.
 */
export const resolveHref = (
  pageUrl: string,
  href: string,
  origin: string | null,
  deployBase = ""
): ResolvedHref => {
  const target = href.trim();
  if (target === "" || target.startsWith("#")) {
    return { kind: "ignored" };
  }
  if (NON_HTTP_SCHEME.test(target)) {
    return { kind: "ignored" };
  }

  // Protocol-relative (`//host/x`) is an absolute URL with the page's scheme.
  const absolute = /^https?:\/\//iu.test(target) || target.startsWith("//");
  if (absolute) {
    let parsed: URL;
    try {
      parsed = new URL(target.startsWith("//") ? `https:${target}` : target);
    } catch {
      return { kind: "ignored" };
    }
    if (origin && parsed.origin === origin) {
      const served = decodePath(parsed.pathname);
      if (!underBase(deployBase, served)) {
        return {
          absolute: true,
          kind: "outside-base",
          path: normalizePath(served),
        };
      }
      return {
        hash: parsed.hash.slice(1),
        kind: "self-origin",
        path: normalizePath(stripBasePath(deployBase, served)),
      };
    }
    return { kind: "external", url: parsed.toString() };
  }

  // A relative href resolves the way a browser resolves it from the page's
  // canonical URL. `URL` needs an origin to do that, so borrow a placeholder
  // one and keep only the path. The canonical URL is slashless — the generated
  // config sets `trailingSlash: "never"`, Vercel redirects `/docs/api/` onto
  // `/docs/api`, and the dev server 404s the slashed form — so `./auth` there
  // means `/docs/auth`, exactly where a reader's click lands. Content links
  // never hit this: the Markdown pipeline rewrites them root-relative (see
  // `resolveRelativeHref`); what's left is hand-written HTML, which a browser
  // reads this way.
  const base = `https://blume.invalid${pageUrl}`;
  let resolved: URL;
  try {
    resolved = new URL(target, base);
  } catch {
    return { kind: "ignored" };
  }
  const served = decodePath(resolved.pathname);
  // Only a root-relative href names the served path outright; a relative one
  // (`./auth`) was resolved against the base-less page URL above, so it
  // inherits the page's base by construction.
  if (target.startsWith("/") && !underBase(deployBase, served)) {
    return {
      absolute: false,
      kind: "outside-base",
      path: normalizePath(served),
    };
  }
  return {
    hash: resolved.hash.slice(1),
    kind: "internal",
    path: normalizePath(stripBasePath(deployBase, served)),
  };
};
