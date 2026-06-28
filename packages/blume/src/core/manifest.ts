import type { ResolvedConfig } from "./schema.ts";
import type {
  BlumeManifest,
  ContentGraph,
  PageRecord,
  ProjectContext,
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

  const routes: RouteManifestEntry[] = graph.pages.map((page) => ({
    contentType: page.contentType,
    draft: page.meta.draft,
    hidden: page.meta.sidebar.hidden,
    id: page.id,
    indexable: searchEnabled && contentIndexable(page, config),
    lastModified: page.lastModified,
    path: page.route,
    sourcePath: page.sourcePath,
    title: page.title,
  }));

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
