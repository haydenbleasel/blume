import { withBasePath } from "./base-path.ts";
import { localizeRoute, resolveFallbackLocale } from "./i18n.ts";
import { validateNavIcons, validateNavStructure } from "./nav-diagnostics.ts";
import { buildNavigation } from "./navigation.ts";
import type {
  FolderMeta,
  LocalizableLabel,
  ResolvedConfig,
  ResolvedI18nConfig,
  ResolvedVersionsConfig,
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
  /** Site-wide route mount point (`""` or `/seg`); invisible to the nav tree. */
  basePath?: string;
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
        route: withBasePath(basePath, localizeRoute(key, code, i18n)),
      });
    }
  }
  return [...real, ...filled];
};

/**
 * Resolve a possibly-per-locale header label to the string a locale renders:
 * the active locale's entry, else the default locale's, else the map's first
 * entry (which is also what a single-locale site gets).
 */
/** A label is either one string for every locale or a per-locale map. */
const isSingleLabel = (label: LocalizableLabel): label is string =>
  typeof label === "string";

const resolveLabel = (
  label: LocalizableLabel,
  locale: string,
  defaultLocale?: string
): string => {
  if (isSingleLabel(label)) {
    return label;
  }
  return (
    label[locale] ??
    (defaultLocale === undefined ? undefined : label[defaultLocale]) ??
    Object.values(label)[0] ??
    ""
  );
};

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
      label: resolveLabel(item.label, locale, defaultLocale),
    })),
    label: resolveLabel(tab.label, locale, defaultLocale),
  }));

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
  // Localize internal tab paths — the tab's own and its dropdown items' — so a
  // header tab points to its in-locale route (e.g. `/docs` -> `/fr/docs`);
  // external paths pass through. Selectors are left alone: a language
  // selector's items intentionally target specific locales.
  // `//host/path` is protocol-relative — an external URL that happens to start
  // with a slash, so it must not pick up a locale prefix. `withBasePath` draws
  // the same line for the same reason.
  const localizePath = (path: string): string =>
    path.startsWith("/") && !path.startsWith("//")
      ? localizeRoute(path, code, i18n)
      : path;
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
      localized.href = localizePath(localized.href);
    }
    return localized;
  });
  const real = pages.filter((page) => page.locale === code);
  const localePages = localePagesFor(
    code,
    real,
    fallback,
    fallbackByKey,
    i18n,
    options.basePath ?? ""
  );
  // Meta files live in locale directories only under the `dir` parser
  // (`fr/guides/meta.ts` -> key `fr/guides`). Under `dot`, translations sit
  // next to the originals and `guides/meta.ts` applies to every locale —
  // prefixing would look up keys that can never exist. Inside a snapshot the
  // version dir is hoisted in front (`v1.0/fr`), matching `discoverFolderMeta`.
  const localeDir =
    i18n.parser === "dir" && code !== i18n.defaultLocale ? code : "";
  // Internal featured and header hrefs are localized like tab paths — a pinned
  // `/changelog` link rendered on `/fr/…` pages must stay inside the reader's
  // locale, not kick them back to the default one.
  const localizeHref = <T extends { href: string }>(item: T): T => ({
    ...item,
    href: localizePath(item.href),
  });
  const { actions, cta, featured } = options.navigation;

  return buildNavigation(localePages, {
    actions: actions?.map(localizeHref),
    basePath: options.basePath ?? "",
    cta: cta ? localizeHref(cta) : null,
    diagnostics,
    display: options.navigation.sidebar.display,
    featured: featured?.map(localizeHref),
    folderMeta: options.folderMeta,
    // The localized tree root ("/" for the hidden default, "/fr" otherwise;
    // "/fr/v1.0" inside a snapshot): the tab pointing here spans the whole
    // tree and must not be treated as a tab section.
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
    // always build from the filesystem.
    sidebar: version ? undefined : options.navigation.sidebar.items,
    tabs,
  });
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
  const fallbackByKey = new Map<string, PageRecord>();
  if (fallback) {
    for (const page of pages) {
      if (page.locale === fallback) {
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
      actions: options.navigation.actions,
      basePath: options.basePath ?? "",
      cta: options.navigation.cta,
      diagnostics,
      display: options.navigation.sidebar.display,
      featured: options.navigation.featured,
      folderMeta: options.folderMeta,
      localizedRoot: versionizeRoute("/", id),
      metaPrefix: id,
      selectors: options.navigation.selectors,
      sharedFolderMeta: options.sharedFolderMeta,
      sharedMetaPrefix: id,
      // A configured explicit sidebar describes the current docs; a snapshot's
      // structure comes from the snapshot itself.
      tabs: resolveTabLabels(options.navigation.tabs, ""),
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
      actions: options.navigation.actions,
      basePath: options.basePath ?? "",
      cta: options.navigation.cta,
      diagnostics,
      display: options.navigation.sidebar.display,
      featured: options.navigation.featured,
      folderMeta: options.folderMeta,
      selectors: options.navigation.selectors,
      sharedFolderMeta: options.sharedFolderMeta,
      sidebar: options.navigation.sidebar.items,
      // No locale to prefer: a per-locale label map resolves to its first
      // entry on a single-locale site.
      tabs: resolveTabLabels(options.navigation.tabs, ""),
    });
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

  return {
    diagnostics,
    navigation,
    navigationByLocale,
    navigationByVersion,
    pages,
    routes,
  };
};
