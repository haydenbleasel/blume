import { localizeRoute, resolveFallbackLocale } from "./i18n.ts";
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

/** Assemble the content graph: routes map, nav, and duplicate diagnostics. */
export const buildContentGraph = (
  pages: PageRecord[],
  options: {
    folderMeta: Map<string, FolderMeta>;
    sharedFolderMeta?: Map<string, FolderMeta>;
    navigation: ResolvedConfig["navigation"];
    i18n?: ResolvedI18nConfig;
  }
): ContentGraph => {
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

  const { i18n } = options;
  const navigationByLocale: Record<string, Navigation> = {};
  let navigation: Navigation;

  if (i18n) {
    // Pages of the fallback locale, by translation key — used to fill in a
    // locale's sidebar for pages it hasn't translated yet, so navigation mirrors
    // the default structure instead of showing an empty (or partial) tree.
    const fallback = resolveFallbackLocale(i18n);
    const fallbackByKey = new Map<string, PageRecord>();
    if (fallback) {
      for (const page of pages) {
        if (page.locale === fallback) {
          fallbackByKey.set(page.translationKey, page);
        }
      }
    }

    // Each locale gets an independent tree from its own pages and folder meta,
    // so navigation may diverge per language (Mintlify-style).
    for (const { code } of i18n.locales) {
      // Localize internal tab paths so a header tab points to its in-locale
      // route (e.g. `/docs` -> `/fr/docs`); external paths pass through.
      const tabs = options.navigation.tabs?.map((tab) => ({
        ...tab,
        path: tab.path.startsWith("/")
          ? localizeRoute(tab.path, code, i18n)
          : tab.path,
      }));

      const real = pages.filter((page) => page.locale === code);
      let localePages = real;
      if (fallback && code !== fallback) {
        const present = new Set(real.map((page) => page.translationKey));
        const filled: PageRecord[] = [];
        for (const [key, source] of fallbackByKey) {
          if (!present.has(key)) {
            filled.push({
              ...source,
              locale: code,
              route: localizeRoute(key, code, i18n),
            });
          }
        }
        localePages = [...real, ...filled];
      }

      navigationByLocale[code] = buildNavigation(localePages, {
        chromeVariants: options.navigation.chromeVariants,
        folderMeta: options.folderMeta,
        metaPrefix: code === i18n.defaultLocale ? "" : code,
        refByLogical: true,
        selectors: options.navigation.selectors,
        sharedFolderMeta: options.sharedFolderMeta,
        sidebar: options.navigation.sidebar,
        sidebarVariants: options.navigation.sidebarVariants,
        tabs,
      });
    }
    navigation = navigationByLocale[i18n.defaultLocale] ?? {
      chromeVariants: [],
      selectors: [],
      sidebar: [],
      sidebarVariants: [],
      tabs: [],
    };
  } else {
    navigation = buildNavigation(pages, {
      chromeVariants: options.navigation.chromeVariants,
      folderMeta: options.folderMeta,
      selectors: options.navigation.selectors,
      sharedFolderMeta: options.sharedFolderMeta,
      sidebar: options.navigation.sidebar,
      sidebarVariants: options.navigation.sidebarVariants,
      tabs: options.navigation.tabs,
    });
  }

  return {
    diagnostics,
    navigation,
    navigationByLocale,
    pages,
    routes,
  };
};
