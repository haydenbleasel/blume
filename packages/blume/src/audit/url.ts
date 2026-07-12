/** What an `href` in built HTML turned out to point at. */
export type ResolvedHref =
  /** A path on this site. */
  | { kind: "internal"; path: string; hash: string }
  /** An absolute URL that resolves back to this site — should have been a path. */
  | { kind: "self-origin"; path: string; hash: string }
  /** An absolute URL on another origin. */
  | { kind: "external"; url: string }
  /** In-page anchor, `mailto:`, `tel:`, `javascript:`, data URI — not a page link. */
  | { kind: "ignored" };

const NON_HTTP_SCHEME = /^(?!https?:)[a-z][a-z0-9+.-]*:/iu;

/**
 * Normalize a site path for comparison: drop the trailing slash (Astro serves
 * `/docs` and `/docs/` as the same page) and collapse an empty path to `/`.
 */
export const normalizePath = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed === "" ? "/" : trimmed;
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
 */
export const resolveHref = (
  pageUrl: string,
  href: string,
  origin: string | null
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
      return {
        hash: parsed.hash.slice(1),
        kind: "self-origin",
        path: normalizePath(parsed.pathname),
      };
    }
    return { kind: "external", url: parsed.toString() };
  }

  // A relative href resolves against the page's own URL. `URL` needs an origin
  // to do that, so borrow a placeholder one and keep only the path. The base
  // carries a trailing slash because Astro's directory build serves `/docs/api`
  // at `/docs/api/` — so in a browser `./auth` there means `/docs/api/auth`, not
  // `/docs/auth`. Resolving against the slashless form would silently mis-target
  // every relative link on the site by one directory level.
  const base =
    pageUrl === "/"
      ? "https://blume.invalid/"
      : `https://blume.invalid${pageUrl}/`;
  let resolved: URL;
  try {
    resolved = new URL(target, base);
  } catch {
    return { kind: "ignored" };
  }
  return {
    hash: resolved.hash.slice(1),
    kind: "internal",
    path: normalizePath(resolved.pathname),
  };
};
