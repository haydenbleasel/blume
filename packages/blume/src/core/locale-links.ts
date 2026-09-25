import {
  isInternalPath,
  mountBasePath,
  normalizePath,
  stripBasePath,
  withBasePath,
} from "./base-path.ts";
import { localePrefix, localizeRoute } from "./i18n.ts";
import type { LocaleRouting } from "./i18n.ts";

/**
 * Locale-aware resolution of content links.
 *
 * Authors write internal links as if mounted at the default locale's root
 * (`[x](/guide)`, `<Card href="/guide">`), and translated pages are usually
 * copies of the source with the same links — so read on `/fr/…`, a link would
 * otherwise drop the reader back into the default language. These helpers move
 * such a link to the reader's locale (`/fr/guide`) when that route is served
 * (a real translation or a materialized fallback page), and leave it alone
 * otherwise: an explicit cross-locale link (`/de/guide`), a custom `.astro`
 * page or generated route that has no per-locale variant, or a missing
 * translation on a site with fallbacks disabled all keep their authored
 * target rather than pointing at a 404.
 *
 * The rewrite runs at render time (`components/layout/LocaleLinks.astro`)
 * because content is compiled once per file but served per route: a fallback
 * route renders the fallback locale's file under the missing locale's URL, and
 * a shared `page.$.mdx` renders under every locale. The link checker applies
 * the same resolution so anchors are validated against the page a reader lands
 * on.
 */

/** A route set, as the runtime (`Set`) or the checker (a predicate) sees it. */
export interface RouteSet {
  has: (route: string) => boolean;
}

export interface LocalizeLinkOptions {
  /** Site-wide route mount point (`""` or `/seg`); routes carry it. */
  basePath: string;
  i18n: LocaleRouting;
  /** Locale of the page the link is rendered on. */
  locale: string;
  /** Every served route, base-prefixed like `path` (no `deployment.base`). */
  routes: RouteSet;
}

/** Decode a percent-encoded path for a route lookup; leave junk as-is. */
const decodePercent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Whether `routes` serves `route` (base-prefixed, fragment-less). Routes are
 * stored decoded, so a browser-copied `/caf%C3%A9` still finds its page.
 */
export const servesRoute = (routes: RouteSet, route: string): boolean =>
  routes.has(route) || routes.has(decodePercent(route));

/** Whether `path` (base-stripped) already sits under some locale's prefix. */
const hasLocalePrefix = (path: string, i18n: LocaleRouting): boolean =>
  i18n.locales.some((locale) => {
    const prefix = localePrefix(locale.code, i18n);
    return prefix !== "" && (path === prefix || path.startsWith(`${prefix}/`));
  });

/**
 * Move a base-prefixed, fragment-less internal path into `locale` when that
 * route is served, else return it unchanged. Idempotent: a path already under
 * any configured locale prefix is never re-prefixed.
 */
export const localizeLinkPath = (
  path: string,
  options: LocalizeLinkOptions
): string => {
  const { basePath, i18n, locale, routes } = options;
  if (localePrefix(locale, i18n) === "") {
    return path;
  }
  const rest = normalizePath(stripBasePath(basePath, path));
  if (hasLocalePrefix(rest, i18n)) {
    return path;
  }
  const localized = withBasePath(basePath, localizeRoute(rest, locale, i18n));
  // A browser-copied `/caf%C3%A9` must still find its translation, but the
  // emitted href keeps the author's encoding.
  return servesRoute(routes, localized) ? localized : path;
};

export interface LocalizeHrefOptions extends LocalizeLinkOptions {
  /** `deployment.base` (Astro's `BASE_URL`), layered over `basePath` in hrefs. */
  deployBase: string;
}

/**
 * Localize a rendered `href`: external URLs, relative paths, and bare
 * fragments pass through; a root-relative page link keeps its `?query` and
 * `#fragment` and its `deployment.base` layer around the localized path.
 *
 * Asset links (`/logo.png`, a raw `.md` twin) pass through too, because no
 * page is served at their localized path — the same served-route test the
 * link checker applies. A file extension alone doesn't mark an asset: a
 * dotted page route (`/releases/v1.2`) is localized like any other page.
 */
export const localizeHref = (
  href: string,
  options: LocalizeHrefOptions
): string => {
  if (!isInternalPath(href)) {
    return href;
  }
  const suffixAt = href.search(/[#?]/u);
  const path = suffixAt === -1 ? href : href.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : href.slice(suffixAt);
  const based = stripBasePath(options.deployBase, path);
  const localized = localizeLinkPath(based, options);
  if (localized === based) {
    return href;
  }
  // The base came off above, so it goes back on unconditionally: a localized
  // path that starts with the base's own name (`/ja/…` under base `/ja`) is
  // still served under it.
  return `${mountBasePath(options.deployBase, localized)}${suffix}`;
};

/** Every `<a …>` opening tag; `\s` keeps `<abbr>`/`<astro-island>` out. */
const ANCHOR_TAG = /<a\s[^>]*>/giu;
/** The tag's `href` attribute, double- or single-quoted. */
const HREF_ATTR = /(?<attr>\shref=)(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')/iu;

/**
 * Rewrite every `<a href>` in rendered content HTML through `rewrite`. Code
 * blocks are HTML-escaped (`&lt;a`), and island props live on
 * `<astro-island>`, so neither is touched.
 */
export const localizeContentLinks = (
  html: string,
  rewrite: (href: string) => string
): string =>
  html.replace(ANCHOR_TAG, (tag) =>
    tag.replace(HREF_ATTR, (_match, attr: string, dq?: string, sq?: string) => {
      const quote = dq === undefined ? "'" : '"';
      return `${attr}${quote}${rewrite(dq ?? sq ?? "")}${quote}`;
    })
  );

/**
 * The served route set for `blume:data`'s routes, built once per routes array
 * (the virtual module is evaluated once, so every page render shares it).
 */
const routeSets = new WeakMap<readonly { path: string }[], Set<string>>();

export const routeSetFor = (
  routes: readonly { path: string }[]
): Set<string> => {
  const cached = routeSets.get(routes);
  if (cached) {
    return cached;
  }
  const built = new Set(routes.map((route) => route.path));
  routeSets.set(routes, built);
  return built;
};
