import { withBasePath } from "./base-path.ts";
import { localizeRoute, resolveFallbackLocale } from "./i18n.ts";
import type { ResolvedConfig } from "./schema.ts";
import type {
  BlumeManifest,
  ContentGraph,
  PageRecord,
  ProjectContext,
  RouteAlternate,
  RouteManifestEntry,
  VersionAlternate,
} from "./types.ts";
import { getBlumeVersion } from "./version.ts";

/**
 * Key for the same logical page across versions within one locale: the
 * version- and locale-agnostic route plus the locale code. NUL never appears
 * in either part, so the join is unambiguous.
 */
const versionAlternateKey = (versionKey: string, locale: string): string =>
  `${versionKey}\u0000${locale}`;

/**
 * Get-or-create the shared alternate list for a (versionKey, locale) pair.
 * Lists are attached to route entries by reference and mutated as fallback
 * routes materialize, then sorted once at the end — every holder sees the
 * final list.
 */
const versionAlternatesFor = (
  byKey: Map<string, VersionAlternate[]>,
  versionKey: string,
  locale: string
): VersionAlternate[] => {
  const key = versionAlternateKey(versionKey, locale);
  const existing = byKey.get(key);
  if (existing) {
    return existing;
  }
  const list: VersionAlternate[] = [];
  byKey.set(key, list);
  return list;
};

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

/**
 * Fallback materialization: render the fallback locale's content at the
 * localized URL for any translation a non-default locale is missing, so static
 * output is fully prerendered (render-fallback, no client redirect). Fallback
 * routes are not indexed and carry no `hreflang` of their own.
 */
/**
 * The description a page's `<head>` emits — `seo.description` over the front
 * matter `description` — mirrored onto its route so the OG card's subtitle
 * matches the page's `og:description`.
 */
const routeDescription = (page: PageRecord): string | undefined =>
  page.meta.seo.description ?? page.description;

const buildFallbackRoutes = (
  graph: ContentGraph,
  i18n: NonNullable<ResolvedConfig["i18n"]>,
  alternatesByKey: Map<string, RouteAlternate[]>,
  basePath: string,
  versionAlternatesByKey: Map<string, VersionAlternate[]> | undefined
): RouteManifestEntry[] => {
  const fallback = resolveFallbackLocale(i18n);
  if (!fallback) {
    return [];
  }
  const fallbackPages = new Map(
    graph.pages.flatMap((page) =>
      page.locale === fallback ? [[page.translationKey, page] as const] : []
    )
  );
  const routes: RouteManifestEntry[] = [];
  for (const { code } of i18n.locales) {
    if (code === fallback) {
      continue;
    }
    const present = new Set(
      graph.pages.flatMap((page) =>
        page.locale === code ? [page.translationKey] : []
      )
    );
    for (const [key, source] of fallbackPages) {
      if (present.has(key)) {
        continue;
      }
      const path = withBasePath(basePath, localizeRoute(key, code, i18n));
      // A fallback route is a real prerendered page, so it registers as a
      // version alternate too — the switcher on a sibling version's page
      // lands here instead of bouncing to the version root. Its own path is
      // recorded (not the fallback source's), keeping the target in-locale.
      const versionAlternates: VersionAlternate[] = versionAlternatesByKey
        ? versionAlternatesFor(versionAlternatesByKey, source.versionKey, code)
        : [];
      if (versionAlternatesByKey) {
        versionAlternates.push({ path, version: source.version });
      }
      routes.push({
        alternates: alternatesByKey.get(key) ?? [],
        collection: source.collection ?? "docs",
        contentType: source.contentType,
        description: routeDescription(source),
        draft: source.meta.draft,
        editUrl: source.editUrl,
        entryId: source.entryId ?? source.source.ref,
        fallback: true,
        hidden: source.meta.sidebar.hidden,
        id: source.id,
        indexable: false,
        lastModified: source.lastModified,
        locale: code,
        path,
        source: source.source,
        sourcePath: source.sourcePath,
        title: source.title,
        version: source.version,
        versionAlternates,
      });
    }
  }
  return routes;
};

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

  // The same logical page across versions, within each locale — for the
  // version switcher and the canonical-to-latest lookup. Built only under
  // versioning; lists are shared by reference and finalized (fallback routes
  // appended, then sorted) before the manifest is returned.
  const versionAlternatesByKey = config.versions
    ? new Map<string, VersionAlternate[]>()
    : undefined;
  if (versionAlternatesByKey) {
    for (const page of graph.pages) {
      versionAlternatesFor(
        versionAlternatesByKey,
        page.versionKey,
        page.locale
      ).push({ path: page.route, version: page.version });
    }
  }

  const routes: RouteManifestEntry[] = graph.pages.map((page) => ({
    alternates: alternatesByKey.get(page.translationKey) ?? [],
    collection: page.collection ?? "docs",
    contentType: page.contentType,
    description: routeDescription(page),
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
    version: page.version,
    versionAlternates: versionAlternatesByKey
      ? versionAlternatesFor(
          versionAlternatesByKey,
          page.versionKey,
          page.locale
        )
      : [],
  }));

  if (i18n) {
    routes.push(
      ...buildFallbackRoutes(
        graph,
        i18n,
        alternatesByKey,
        config.basePath,
        versionAlternatesByKey
      )
    );
  }

  // Alternate lists read current-first, then archived versions in configured
  // (switcher) order. Sorted once here — every route holding a list by
  // reference sees the final ordering.
  if (versionAlternatesByKey && config.versions) {
    const rank = new Map<string, number>(
      config.versions.archived.map((version, index) => [version.id, index + 1])
    );
    for (const list of versionAlternatesByKey.values()) {
      list.sort(
        (a, b) => (rank.get(a.version) ?? 0) - (rank.get(b.version) ?? 0)
      );
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
