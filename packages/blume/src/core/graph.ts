import { mountBasePath, withBasePath } from "./base-path.ts";
import {
  localizeInternalPath,
  localizeRoute,
  resolveFallbackLocale,
} from "./i18n.ts";
import { resolveLocalizable } from "./localizable.ts";
import {
  validateNavIcons,
  validateNavStructure,
  validateSidebarItems,
} from "./nav-diagnostics.ts";
import { buildNavigation, isPageRef, pagesByRef } from "./navigation.ts";
import type { DatedGroups } from "./navigation.ts";
import type {
  FolderMeta,
  LocalizableLabel,
  ResolvedConfig,
  ResolvedI18nConfig,
  ResolvedVersionsConfig,
  SidebarItemConfig,
} from "./schema.ts";
import type {
  ContentGraph,
  Diagnostic,
  Navigation,
  NavTab,
  PageRecord,
} from "./types.ts";
import { versionizeRoute } from "./versions.ts";

interface BuildContentGraphOptions {
  /** The banner's link target as configured (`banner.link.href`), if any. */
  bannerHref?: string;
  /** Site-wide route mount point (`""` or `/seg`); invisible to the nav tree. */
  basePath?: string;
  /** The header brand link as configured (`logo.href`, default `/`). */
  brandHref?: string;
  /** Routes served outside the content tree that tabs may link to directly. */
  extraRoutes?: ReadonlySet<string>;
  /** How dated entries (blog posts, changelog entries) group in the sidebar. */
  datedGroups?: DatedGroups;
  /** The time zone the sidebar reads dated entries' periods in. */
  timeZone?: string;
  folderMeta: Map<string, FolderMeta>;
  sharedFolderMeta?: Map<string, FolderMeta>;
  navigation: ResolvedConfig["navigation"];
  i18n?: ResolvedI18nConfig;
  versions?: ResolvedVersionsConfig;
}

type FallbackLocale = ReturnType<typeof resolveFallbackLocale>;

/** Build the route → page-id map, flagging any duplicate-route collisions. */
const collectRoutes = (pages: PageRecord[]) => {
  const routes = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  for (const page of pages) {
    const existing = routes.get(page.route);
    if (existing) {
      diagnostics.push({
        code: "BLUME_DUPLICATE_ROUTE",
        file: page.sourcePath ?? page.id,
        message: `Two files resolve to ${page.route}: ${existing} and ${page.id}`,
        severity: "error",
        suggestion: "Rename or move one of the files so each route is unique.",
      });
      continue;
    }
    routes.set(page.route, page.id);
  }
  return { diagnostics, routes };
};

/**
 * A locale's pages, padded with fallback-locale entries for any translation it
 * hasn't authored yet, so navigation mirrors the default structure instead of
 * showing an empty (or partial) tree.
 */
const localePagesFor = (
  code: string,
  real: PageRecord[],
  fallback: FallbackLocale,
  fallbackByKey: Map<string, PageRecord>,
  i18n: ResolvedI18nConfig,
  basePath: string
): PageRecord[] => {
  if (!(fallback && code !== fallback)) {
    return real;
  }
  const present = new Set(real.map((page) => page.translationKey));
  const filled: PageRecord[] = [];
  for (const [key, source] of fallbackByKey) {
    if (!present.has(key)) {
      filled.push({
        ...source,
        fallback: true,
        locale: code,
        route: mountBasePath(basePath, localizeRoute(key, code, i18n)),
      });
    }
  }
  return [...real, ...filled];
};

/**
 * An explicit sidebar with every item's `href` passed through `localize` (page
 * refs and `root`s resolve against each locale's own pages already).
 */
const localizeSidebarHrefs = (
  items: SidebarItemConfig[],
  localize: (href: string) => string
): SidebarItemConfig[] =>
  items.map((item) => {
    if (isPageRef(item)) {
      return item;
    }
    const localized = { ...item };
    if (item.href !== undefined) {
      localized.href = localize(item.href);
    }
    if (item.items) {
      localized.items = localizeSidebarHrefs(item.items, localize);
    }
    return localized;
  });

/** Resolve every localizable label in the configured tabs for one locale. */
const resolveTabLabels = (
  tabs: BuildContentGraphOptions["navigation"]["tabs"],
  locale: string,
  defaultLocale?: string
): NavTab[] =>
  (tabs ?? []).map((tab) => ({
    ...tab,
    items: tab.items?.map((item) => ({
      ...item,
      label: resolveLocalizable(item.label, locale, defaultLocale),
    })),
    label: resolveLocalizable(tab.label, locale, defaultLocale),
  }));

/** A configured header or footer link with its label resolved for a locale. */
const withLabel = <T extends { label: LocalizableLabel }>(
  link: T,
  locale: string,
  defaultLocale?: string
): Omit<T, "label"> & { label: string } => ({
  ...link,
  label: resolveLocalizable(link.label, locale, defaultLocale),
});

/** The configured header links (plain, call to action, featured) in `locale`. */
const resolveHeaderLinks = (
  navigation: BuildContentGraphOptions["navigation"],
  locale: string,
  defaultLocale?: string
) => ({
  actions: navigation.actions.map((link) =>
    withLabel(link, locale, defaultLocale)
  ),
  cta: navigation.cta ? withLabel(navigation.cta, locale, defaultLocale) : null,
  featured: navigation.featured.map((link) =>
    withLabel(link, locale, defaultLocale)
  ),
});

/**
 * Mount a configured link authored as if the site were served at root (the
 * banner's): under `basePath`, except a route served outside the content tree
 * — a custom page, the generated changelog index — which answers only at its
 * own path.
 */
const mountConfiguredLink = (
  path: string,
  basePath: string,
  extraRoutes: ReadonlySet<string>
): string => (extraRoutes.has(path) ? path : withBasePath(basePath, path));

/**
 * Build one locale's navigation tree from its own pages and folder meta.
 * `version` is the archived version id when building a snapshot's tree
 * (`""` for the current docs): it shifts the folder-meta lookups into the
 * snapshot's key space and roots the tree at the localized version root.
 */
const buildLocaleNavigation = (
  code: string,
  pages: PageRecord[],
  fallback: FallbackLocale,
  fallbackByKey: Map<string, PageRecord>,
  options: BuildContentGraphOptions,
  i18n: ResolvedI18nConfig,
  diagnostics: Diagnostic[],
  version = ""
): Navigation => {
  const basePath = options.basePath ?? "";
  const real = pages.filter((page) => page.locale === code);
  const localePages = localePagesFor(
    code,
    real,
    fallback,
    fallbackByKey,
    i18n,
    basePath
  );
  // Every route the build serves: each locale's pages (this locale's fallback
  // copies included) plus the routes outside the content tree — custom pages
  // and the generated changelog index, which mount outside `basePath`.
  const pageRoutes = [
    ...new Set([...pages, ...localePages].map((page) => page.route)),
  ];
  const extraRoutes = options.extraRoutes ?? new Set<string>();
  // Whether `path` (authored at root, like a tab path) is served — exactly, or
  // with `section`, as the prefix of a served page (a tab resolves to its
  // section's first page, a plain link doesn't).
  const serves = (path: string, section: boolean): boolean => {
    if (extraRoutes.has(path)) {
      return true;
    }
    const based = withBasePath(basePath, path);
    const prefix = based === "/" ? "/" : `${based}/`;
    return pageRoutes.some(
      (route) => route === based || (section && route.startsWith(prefix))
    );
  };
  // Localize an internal link so it points to its in-locale route (e.g. `/docs`
  // -> `/fr/docs`); external paths pass through. A route this locale doesn't
  // serve while the default one does — a custom page, the generated changelog
  // index — exists only at its own path, so the link stays there instead of
  // 404ing. Tab paths (and their dropdown items') resolve to a section's first
  // page, so a translated section counts; hrefs must be served exactly.
  // Selectors are left alone: a language selector's items intentionally target
  // specific locales. The header's brand link resolves the same way, so the
  // logo and the tabs beside it always agree on the reader's locale.
  const localizeServed = (path: string, section: boolean): string => {
    const localized = localizeInternalPath(path, code, i18n);
    return localized === path ||
      serves(localized, section) ||
      !serves(path, section)
      ? localized
      : path;
  };
  const localizePath = (path: string): string => localizeServed(path, true);
  const tabs = resolveTabLabels(
    options.navigation.tabs,
    code,
    i18n.defaultLocale
  ).map((tab) => {
    const localized = {
      ...tab,
      items: tab.items?.map((item) => ({
        ...item,
        path: localizePath(item.path),
      })),
      path: localizePath(tab.path),
    };
    if (localized.href) {
      localized.href = localizeServed(localized.href, false);
    }
    return localized;
  });
  // Meta files live in locale directories only under the `dir` parser
  // (`fr/guides/meta.ts` -> key `fr/guides`). Under `dot`, translations sit
  // next to the originals and `guides/meta.ts` applies to every locale —
  // prefixing would look up keys that can never exist. Inside a snapshot the
  // version dir is hoisted in front (`v1.0/fr`), matching `discoverFolderMeta`.
  const localeDirOf = (locale: string): string =>
    i18n.parser === "dir" && locale !== i18n.defaultLocale ? locale : "";
  const localeDir = localeDirOf(code);
  // A locale padded from the fallback locale mirrors that locale's folder meta
  // for any folder it has no meta of its own for.
  const fallbackMetaPrefix =
    fallback && code !== fallback
      ? [version, localeDirOf(fallback)].filter(Boolean).join("/")
      : undefined;
  // Internal featured and header hrefs are localized like tab paths — a pinned
  // `/changelog` link rendered on `/fr/…` pages must stay inside the reader's
  // locale, not kick them back to the default one.
  const localizeHref = <T extends { href: string }>(item: T): T => ({
    ...item,
    href: localizeServed(item.href, false),
  });
  const { actions, cta, featured } = resolveHeaderLinks(
    options.navigation,
    code,
    i18n.defaultLocale
  );
  const sidebarItems = options.navigation.sidebar.items;

  const navigation = buildNavigation(localePages, {
    actions: actions.map(localizeHref),
    basePath,
    cta: cta ? localizeHref(cta) : null,
    datedGroups: options.datedGroups,
    diagnostics,
    display: options.navigation.sidebar.display,
    extraRoutes: options.extraRoutes,
    fallbackMetaPrefix,
    featured: featured.map(localizeHref),
    folderMeta: options.folderMeta,
    // The localized tree root ("/" for the hidden default, "/fr" otherwise;
    // "/fr/v1.0" inside a snapshot): the tab pointing here spans the whole
    // tree and must not be treated as a tab section.
    locale: code,
    localizedRoot: localizeRoute(versionizeRoute("/", version), code, i18n),
    metaPrefix: [version, localeDir].filter(Boolean).join("/"),
    refByLogical: true,
    selectors: options.navigation.selectors,
    sharedFolderMeta: options.sharedFolderMeta,
    // Shared `meta.$.*` files are locale-agnostic but version-specific: a
    // snapshot's shared meta keys under its version dir.
    sharedMetaPrefix: version,
    // A configured explicit sidebar describes the current docs; a frozen
    // snapshot's structure comes from the snapshot itself, so archived trees
    // always build from the filesystem. Its `href` links are localized like
    // featured links.
    sidebar:
      version || !sidebarItems
        ? undefined
        : localizeSidebarHrefs(sidebarItems, (href) =>
            localizeServed(href, false)
          ),
    // Tab paths are written against the current docs' root, which a
    // snapshot's versionized `localizedRoot` no longer is.
    tabRoot: localizeRoute("/", code, i18n),
    tabs,
    timeZone: options.timeZone,
  });
  // `serves` checked the localized brand link against based routes, and
  // unlike tab and header links it isn't rebased later, so a localized one
  // takes the base here (`/fr` is served at `/docs/fr`).
  const localizedBrand = (href: string): string => {
    const localized = localizeServed(href, false);
    return localized === href ? localized : withBasePath(basePath, localized);
  };
  const branded =
    options.brandHref === undefined
      ? navigation
      : { ...navigation, brandHref: localizedBrand(options.brandHref) };
  // The banner link is authored like a featured href — in the default
  // locale's path space, as if mounted at root — so it is localized the same
  // way before it is mounted.
  return options.bannerHref === undefined
    ? branded
    : {
        ...branded,
        bannerHref: mountConfiguredLink(
          localizeServed(options.bannerHref, false),
          basePath,
          extraRoutes
        ),
      };
};

/**
 * Per-locale navigation trees plus the default-locale tree for i18n sites.
 * Called once for the current docs and once per archived version (with that
 * version's pages and its id as `version`).
 */
const buildI18nNavigation = (
  pages: PageRecord[],
  options: BuildContentGraphOptions,
  i18n: ResolvedI18nConfig,
  diagnostics: Diagnostic[],
  version = ""
) => {
  // Pages of the fallback locale, by translation key — used to fill in a
  // locale's sidebar for pages it hasn't translated yet.
  const fallback = resolveFallbackLocale(i18n);
  // Monolingual pages (GitHub releases) are left out: they aren't served at the
  // other locales' URLs (see the route manifest), so no sidebar may link there.
  const fallbackByKey = new Map<string, PageRecord>();
  if (fallback) {
    for (const page of pages) {
      if (page.locale === fallback && !page.monolingual) {
        fallbackByKey.set(page.translationKey, page);
      }
    }
  }

  // Each locale gets an independent tree, so navigation may diverge per language.
  // Untranslated pages are padded into every locale from the fallback, so a tie
  // in shared content would otherwise be re-reported once per locale — dedupe on
  // code + file + message, which are all locale-stable for padded pages. A
  // locale-specific tie names its own translated files/labels and survives.
  const navigationByLocale: Record<string, Navigation> = {};
  const seen = new Set<string>();
  for (const { code } of i18n.locales) {
    const localeDiagnostics: Diagnostic[] = [];
    navigationByLocale[code] = buildLocaleNavigation(
      code,
      pages,
      fallback,
      fallbackByKey,
      options,
      i18n,
      localeDiagnostics,
      version
    );
    for (const diagnostic of localeDiagnostics) {
      const key = `${diagnostic.code}\n${diagnostic.file ?? ""}\n${diagnostic.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(diagnostic);
      }
    }
  }
  const navigation: Navigation = navigationByLocale[i18n.defaultLocale] ?? {
    featured: [],
    selectors: [],
    sidebar: [],
    tabs: [],
  };
  return { navigation, navigationByLocale };
};

/** One archived version's navigation trees, keyed by locale (`""` sans i18n). */
const buildVersionNavigation = (
  id: string,
  versionPages: PageRecord[],
  options: BuildContentGraphOptions,
  diagnostics: Diagnostic[]
) => {
  const { i18n } = options;
  if (i18n) {
    return buildI18nNavigation(versionPages, options, i18n, diagnostics, id)
      .navigationByLocale;
  }
  return {
    "": buildNavigation(versionPages, {
      ...resolveHeaderLinks(options.navigation, ""),
      basePath: options.basePath ?? "",
      datedGroups: options.datedGroups,
      diagnostics,
      display: options.navigation.sidebar.display,
      extraRoutes: options.extraRoutes,
      folderMeta: options.folderMeta,
      localizedRoot: versionizeRoute("/", id),
      metaPrefix: id,
      selectors: options.navigation.selectors,
      sharedFolderMeta: options.sharedFolderMeta,
      sharedMetaPrefix: id,
      // Tab paths are written against the current docs' root.
      tabRoot: "/",
      // A configured explicit sidebar describes the current docs; a snapshot's
      // structure comes from the snapshot itself.
      tabs: resolveTabLabels(options.navigation.tabs, ""),
      timeZone: options.timeZone,
    }),
  };
};

/** Assemble the content graph: routes map, nav, and duplicate diagnostics. */
export const buildContentGraph = (
  pages: PageRecord[],
  options: BuildContentGraphOptions
): ContentGraph => {
  const { diagnostics, routes } = collectRoutes(pages);
  const { i18n } = options;

  // Under versioning, each version gets independent trees: navPath is
  // version-stripped, so mixing versions into one build would collide the
  // same logical page once per version.
  const currentPages = options.versions
    ? pages.filter((page) => page.version === "")
    : pages;

  // A single-locale site has no per-locale trees; the empty map is its
  // navigationByLocale.
  let navigationByLocale: Record<string, Navigation> = {};
  let navigation: Navigation;
  if (i18n) {
    ({ navigation, navigationByLocale } = buildI18nNavigation(
      currentPages,
      options,
      i18n,
      diagnostics
    ));
  } else {
    navigation = buildNavigation(currentPages, {
      // No locale to prefer: a per-locale label map resolves to its first
      // entry on a single-locale site.
      ...resolveHeaderLinks(options.navigation, ""),
      basePath: options.basePath ?? "",
      datedGroups: options.datedGroups,
      diagnostics,
      display: options.navigation.sidebar.display,
      extraRoutes: options.extraRoutes,
      folderMeta: options.folderMeta,
      selectors: options.navigation.selectors,
      sharedFolderMeta: options.sharedFolderMeta,
      sidebar: options.navigation.sidebar.items,
      // No locale to prefer: a per-locale label map resolves to its first
      // entry on a single-locale site.
      tabs: resolveTabLabels(options.navigation.tabs, ""),
      timeZone: options.timeZone,
    });
    if (options.bannerHref !== undefined) {
      navigation = {
        ...navigation,
        bannerHref: mountConfiguredLink(
          options.bannerHref,
          options.basePath ?? "",
          options.extraRoutes ?? new Set<string>()
        ),
      };
    }
  }

  const navigationByVersion: Record<string, Record<string, Navigation>> = {};
  for (const { id } of options.versions?.archived ?? []) {
    navigationByVersion[id] = buildVersionNavigation(
      id,
      pages.filter((page) => page.version === id),
      options,
      diagnostics
    );
  }

  // Icon typos, duplicate labels, and hidden-page-in-sidebar are validated on
  // the built navigation. Missing-target detection needs the full route set
  // (incl. custom + generated pages), so it runs later in generateRuntime.
  diagnostics.push(
    ...validateNavIcons(navigation),
    ...validateNavStructure(navigation, currentPages)
  );
  // Checked once against every locale's pages, not per locale tree: a page
  // missing from one locale's sidebar is an untranslated page, not a typo.
  const sidebarItems = options.navigation.sidebar.items;
  if (sidebarItems) {
    const byRef = pagesByRef(
      currentPages,
      options.basePath ?? "",
      Boolean(i18n)
    );
    const extraRoutes = options.extraRoutes ?? new Set<string>();
    diagnostics.push(
      ...validateSidebarItems(
        sidebarItems,
        (route) => byRef.has(route) || extraRoutes.has(route)
      )
    );
  }

  return {
    diagnostics,
    navigation,
    navigationByLocale,
    navigationByVersion,
    pages,
    routes,
  };
};
