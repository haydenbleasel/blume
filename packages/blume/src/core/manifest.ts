import type { ResolvedConfig } from "./schema.ts";
import type {
  BlumeManifest,
  ContentGraph,
  ProjectContext,
  RouteManifestEntry,
} from "./types.ts";
import { getBlumeVersion } from "./version.ts";

/** The current manifest schema version. */
export const MANIFEST_VERSION = 1;

/** Build the runtime manifest that bridges core and the generated Astro app. */
export const buildManifest = (options: {
  context: ProjectContext;
  config: ResolvedConfig;
  graph: ContentGraph;
}): BlumeManifest => {
  const { context, config, graph } = options;
  const searchEnabled = config.search.provider !== "none";
  const { includeHiddenPages } = config.search.indexing;

  const routes: RouteManifestEntry[] = graph.pages.map((page) => ({
    contentType: page.contentType,
    draft: page.meta.draft,
    hidden: page.meta.sidebar.hidden,
    id: page.id,
    indexable:
      searchEnabled &&
      !page.meta.search.exclude &&
      (!page.meta.sidebar.hidden || includeHiddenPages),
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
