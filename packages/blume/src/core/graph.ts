import { withBasePath } from "./base-path.ts";
import { localizeRoute, resolveFallbackLocale } from "./i18n.ts";
import { validateNavIcons, validateNavStructure } from "./nav-diagnostics.ts";
import { buildNavigation } from "./navigation.ts";
import type {
  FolderMeta,
  ResolvedConfig,
  ResolvedI18nConfig,
} from "./schema.ts";
import type {
  ContentGraph,
  Diagnostic,
  Navigation,
  PageRecord,
} from "./types.ts";

interface BuildContentGraphOptions {
  /** Site-wide route mount point (`""` or `/seg`); invisible to the nav tree. */
  basePath?: string;
  folderMeta: Map<string, FolderMeta>;
  sharedFolderMeta?: Map<string, FolderMeta>;
  navigation: ResolvedConfig["navigation"];
  i18n?: ResolvedI18nConfig;
}

type FallbackLocale = ReturnType<typeof resolveFallbackLocale>;

/** Build the route → page-id map, flagging any duplicate-route collisions. */
const collectRoutes = (
  pages: PageRecord[]
): { diagnostics: Diagnostic[]; routes: Map<string, string> } => {
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

/** Build one locale's navigation tree from its own pages and folder meta. */
const buildLocaleNavigation = (
  code: string,
  pages: PageRecord[],
  fallback: FallbackLocale,
  fallbackByKey: Map<string, PageRecord>,
  options: BuildContentGraphOptions,
  i18n: ResolvedI18nConfig,
  diagnostics: Diagnostic[]
): Navigation => {
  // Localize internal tab paths — the tab's own and its dropdown items' — so a
  // header tab points to its in-locale route (e.g. `/docs` -> `/fr/docs`);
  // external paths pass through. Selectors are left alone: a language
  // selector's items intentionally target specific locales.
  const localizePath = (path: string): string =>
    path.startsWith("/") ? localizeRoute(path, code, i18n) : path;
  const tabs = options.navigation.tabs?.map((tab) => ({
    ...tab,
    items: tab.items?.map((item) => ({
      ...item,
      path: localizePath(item.path),
    })),
    path: localizePath(tab.path),
  }));
  const real = pages.filter((page) => page.locale === code);
  const localePages = localePagesFor(
    code,
    real,
    fallback,
    fallbackByKey,
    i18n,
    options.basePath ?? ""
  );
  return buildNavigation(localePages, {
    basePath: options.basePath ?? "",
    diagnostics,
    display: options.navigation.sidebar.display,
    featured: options.navigation.featured,
    folderMeta: options.folderMeta,
    // The localized tree root ("/" for the hidden default, "/fr" otherwise):
    // the tab pointing here spans the whole tree and must not be treated as a
    // tab section.
    localizedRoot: localizeRoute("/", code, i18n),
    // Meta files live in locale directories only under the `dir` parser
    // (`fr/guides/meta.ts` -> key `fr/guides`). Under `dot`, translations sit
    // next to the originals and `guides/meta.ts` applies to every locale —
    // prefixing would look up keys that can never exist.
    metaPrefix:
      i18n.parser === "dir" && code !== i18n.defaultLocale ? code : "",
    refByLogical: true,
    selectors: options.navigation.selectors,
    sharedFolderMeta: options.sharedFolderMeta,
    sidebar: options.navigation.sidebar.items,
    tabs,
  });
};

/** Per-locale navigation trees plus the default-locale tree for i18n sites. */
const buildI18nNavigation = (
  pages: PageRecord[],
  options: BuildContentGraphOptions,
  i18n: ResolvedI18nConfig,
  diagnostics: Diagnostic[]
): {
  navigation: Navigation;
  navigationByLocale: Record<string, Navigation>;
} => {
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
      localeDiagnostics
    );
    for (const diagnostic of localeDiagnostics) {
      const key = `${diagnostic.code}\n${diagnostic.file ?? ""}\n${diagnostic.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(diagnostic);
      }
    }
  }
  const navigation = navigationByLocale[i18n.defaultLocale] ?? {
    featured: [],
    selectors: [],
    sidebar: [],
    tabs: [],
  };
  return { navigation, navigationByLocale };
};

/** Assemble the content graph: routes map, nav, and duplicate diagnostics. */
export const buildContentGraph = (
  pages: PageRecord[],
  options: BuildContentGraphOptions
): ContentGraph => {
  const { diagnostics, routes } = collectRoutes(pages);
  const { i18n } = options;

  const { navigation, navigationByLocale } = i18n
    ? buildI18nNavigation(pages, options, i18n, diagnostics)
    : {
        navigation: buildNavigation(pages, {
          basePath: options.basePath ?? "",
          diagnostics,
          display: options.navigation.sidebar.display,
          featured: options.navigation.featured,
          folderMeta: options.folderMeta,
          selectors: options.navigation.selectors,
          sharedFolderMeta: options.sharedFolderMeta,
          sidebar: options.navigation.sidebar.items,
          tabs: options.navigation.tabs,
        }),
        navigationByLocale: {} as Record<string, Navigation>,
      };

  // Icon typos, duplicate labels, and hidden-page-in-sidebar are validated on
  // the built navigation. Missing-target detection needs the full route set
  // (incl. custom + generated pages), so it runs later in generateRuntime.
  diagnostics.push(
    ...validateNavIcons(navigation),
    ...validateNavStructure(navigation, pages)
  );

  return {
    diagnostics,
    navigation,
    navigationByLocale,
    pages,
    routes,
  };
};
