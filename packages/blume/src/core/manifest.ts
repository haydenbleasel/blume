import { localizeRoute, resolveFallbackLocale } from "./i18n.ts";
import type { ResolvedConfig } from "./schema.ts";
import type {
  BlumeManifest,
  ContentGraph,
  PageRecord,
  ProjectContext,
  RouteAlternate,
  RouteManifestEntry,
} from "./types.ts";
import { getBlumeVersion } from "./version.ts";

/** The current manifest schema version. */
export const MANIFEST_VERSION = 1;

/**
 * Whether a page may be indexed on its own merits — not author-excluded and not
 * hidden (unless hidden pages are opted in). This is independent of whether the
 * site search provider is enabled, so features like the MCP server can index
 * docs even when on-page search is off.
 */
export const contentIndexable = (
  page: PageRecord,
  config: ResolvedConfig
): boolean =>
  !page.meta.search.exclude &&
  (!page.meta.sidebar.hidden || config.search.indexing.includeHiddenPages);

/** Build the runtime manifest that bridges core and the generated Astro app. */
export const buildManifest = (options: {
  context: ProjectContext;
  config: ResolvedConfig;
  graph: ContentGraph;
}): BlumeManifest => {
  const { context, config, graph } = options;
  const searchEnabled = config.search.provider !== "none";
  const { i18n } = config;

  // Real translations per logical page, for `hreflang` and the switcher. Built
  // only under i18n; a single-locale page has no alternates.
  const alternatesByKey = new Map<string, RouteAlternate[]>();
  if (i18n) {
    for (const page of graph.pages) {
      const list = alternatesByKey.get(page.translationKey) ?? [];
      list.push({ locale: page.locale, path: page.route });
      alternatesByKey.set(page.translationKey, list);
    }
  }

  const routes: RouteManifestEntry[] = graph.pages.map((page) => ({
    alternates: alternatesByKey.get(page.translationKey) ?? [],
    collection: page.collection ?? "docs",
    contentType: page.contentType,
    draft: page.meta.draft,
    editUrl: page.editUrl,
    entryId: page.entryId ?? page.source.ref,
    hidden: page.meta.sidebar.hidden,
    id: page.id,
    indexable: searchEnabled && contentIndexable(page, config),
    lastModified: page.lastModified,
    locale: page.locale,
    path: page.route,
    source: page.source,
    sourcePath: page.sourcePath,
    title: page.title,
  }));

  // Fallback materialization: render the fallback locale's content at the
  // localized URL for any translation a non-default locale is missing, so static
  // output is fully prerendered (render-fallback, no client redirect). Fallback
  // routes are not indexed and carry no `hreflang` of their own.
  if (i18n) {
    const fallback = resolveFallbackLocale(i18n);
    if (fallback) {
      const fallbackPages = new Map(
        graph.pages
          .filter((page) => page.locale === fallback)
          .map((page) => [page.translationKey, page] as const)
      );
      for (const { code } of i18n.locales) {
        if (code === fallback) {
          continue;
        }
        const present = new Set(
          graph.pages
            .filter((page) => page.locale === code)
            .map((page) => page.translationKey)
        );
        for (const [key, source] of fallbackPages) {
          if (present.has(key)) {
            continue;
          }
          routes.push({
            alternates: alternatesByKey.get(key) ?? [],
            collection: source.collection ?? "docs",
            contentType: source.contentType,
            draft: source.meta.draft,
            editUrl: source.editUrl,
            entryId: source.entryId ?? source.source.ref,
            fallback: true,
            hidden: source.meta.sidebar.hidden,
            id: source.id,
            indexable: false,
            lastModified: source.lastModified,
            locale: code,
            path: localizeRoute(key, code, i18n),
            source: source.source,
            sourcePath: source.sourcePath,
            title: source.title,
          });
        }
      }
    }
  }

  routes.sort((a, b) => a.path.localeCompare(b.path));

  return {
    blumeVersion: getBlumeVersion(),
    contentRoot: context.contentRoot,
    output: config.deployment.output,
    projectRoot: context.root,
    routes,
    version: MANIFEST_VERSION,
  };
};
