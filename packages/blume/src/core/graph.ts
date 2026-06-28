import { localizeRoute } from "./i18n.ts";
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
        file: page.sourcePath,
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
      navigationByLocale[code] = buildNavigation(
        pages.filter((page) => page.locale === code),
        {
          folderMeta: options.folderMeta,
          metaPrefix: code === i18n.defaultLocale ? "" : code,
          refByLogical: true,
          sharedFolderMeta: options.sharedFolderMeta,
          sidebar: options.navigation.sidebar,
          tabs,
        }
      );
    }
    navigation = navigationByLocale[i18n.defaultLocale] ?? {
      sidebar: [],
      tabs: [],
    };
  } else {
    navigation = buildNavigation(pages, {
      folderMeta: options.folderMeta,
      sharedFolderMeta: options.sharedFolderMeta,
      sidebar: options.navigation.sidebar,
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
