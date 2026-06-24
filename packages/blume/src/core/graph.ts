import { buildNavigation } from "./navigation.ts";
import type { FolderMeta, ResolvedConfig } from "./schema.ts";
import type { ContentGraph, Diagnostic, PageRecord } from "./types.ts";

/** Assemble the content graph: routes map, nav, and duplicate diagnostics. */
export const buildContentGraph = (
  pages: PageRecord[],
  options: {
    folderMeta: Map<string, FolderMeta>;
    navigation: ResolvedConfig["navigation"];
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

  const navigation = buildNavigation(pages, {
    chromeVariants: options.navigation.chromeVariants,
    folderMeta: options.folderMeta,
    selectors: options.navigation.selectors,
    sidebar: options.navigation.sidebar,
    sidebarVariants: options.navigation.sidebarVariants,
    tabs: options.navigation.tabs,
  });

  return {
    diagnostics,
    navigation,
    pages,
    routes,
  };
};
