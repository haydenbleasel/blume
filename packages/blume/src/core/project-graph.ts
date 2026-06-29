import { loadConfig } from "./config.ts";
import { buildContentGraph } from "./graph.ts";
import { i18nDiagnostics } from "./i18n.ts";
import {
  gitLastModifiedTimes,
  resolveLastModifiedConfig,
} from "./last-modified.ts";
import { buildManifest } from "./manifest.ts";
import { discoverFolderMeta } from "./meta.ts";
import { resolveProjectContext } from "./project.ts";
import type { ResolvedConfig } from "./schema.ts";
import { normalizeEntry } from "./sources/normalize.ts";
import { resolveSources } from "./sources/resolve.ts";
import type { ContentSource } from "./sources/types.ts";
import type {
  BlumeManifest,
  ContentGraph,
  Diagnostic,
  PageRecord,
  ProjectContext,
} from "./types.ts";

/** Build mode: drafts are kept in `dev` and dropped in `build`. */
export type BuildMode = "dev" | "build";

/** Everything Blume knows about a project after a full scan. */
export interface BlumeProject {
  mode: BuildMode;
  context: ProjectContext;
  config: ResolvedConfig;
  graph: ContentGraph;
  manifest: BlumeManifest;
  diagnostics: Diagnostic[];
  /** The instantiated content sources, for lazy entry reads (search/AI/raw). */
  sources: ContentSource[];
}

/**
 * Run the full core pipeline for a project root: load config, resolve paths,
 * discover content and folder meta, build the graph, and assemble the manifest.
 * Collects all diagnostics without throwing on content-level problems so
 * callers can decide how strict to be.
 */
export const scanProject = async (
  root: string,
  options: {
    devServerUrl?: string;
    mode?: BuildMode;
    preview?: boolean;
    refresh?: boolean;
  } = {}
): Promise<BlumeProject> => {
  const mode = options.mode ?? "dev";
  const preview = options.preview ?? false;
  const { config } = await loadConfig(root, {
    devServerUrl: options.devServerUrl,
  });
  const context = resolveProjectContext(root, config);

  // Each source validates itself (e.g. the filesystem source checks its root
  // exists), replacing the single hard `contentRoot` check.
  const sources = resolveSources(config, context, {
    mode,
    preview,
    refresh: options.refresh,
  });
  for (const source of sources) {
    source.validate?.();
  }

  // Run every source's `load()` in parallel, then funnel each entry through the
  // shared `normalizeEntry` so route mapping is identical regardless of origin.
  const [loaded, folderMeta] = await Promise.all([
    Promise.all(
      sources.map(async (source) => ({ source, ...(await source.load()) }))
    ),
    discoverFolderMeta(context.contentRoot),
  ]);

  const allPages: PageRecord[] = [];
  const contentDiagnostics: Diagnostic[] = [];
  for (const { source, entries, diagnostics } of loaded) {
    contentDiagnostics.push(...diagnostics);
    for (const entry of entries) {
      const normalized = normalizeEntry(entry, {
        defaultType: config.content.defaultType,
        i18n: config.i18n,
        source: {
          name: source.name,
          prefix: source.prefix,
          staged: source.staged,
        },
      });
      allPages.push(...normalized.pages);
      contentDiagnostics.push(...normalized.diagnostics);
    }
  }

  // Drafts render in dev and in preview, but are excluded from production builds.
  const pages =
    mode === "build" && !preview
      ? allPages.filter((page) => !page.meta.draft)
      : allPages;

  // Resolve "last updated" dates before the graph is built so the manifest
  // (which shares these page objects) picks them up. Frontmatter always wins;
  // git applies to filesystem entries, other sources supply dates on the entry.
  const lastModified = resolveLastModifiedConfig(config.lastModified);
  if (lastModified.enabled && lastModified.source === "git") {
    const fsPaths = pages
      .map((page) => page.sourcePath)
      .filter((path): path is string => path !== undefined);
    const gitTimes = gitLastModifiedTimes(
      context.root,
      context.contentRoot,
      fsPaths
    );
    for (const page of pages) {
      if (!page.lastModified && page.sourcePath) {
        page.lastModified = gitTimes.get(page.sourcePath);
      }
    }
  }

  const graph = buildContentGraph(pages, {
    folderMeta: folderMeta.meta,
    i18n: config.i18n,
    navigation: config.navigation,
    sharedFolderMeta: folderMeta.shared,
  });
  const manifest = buildManifest({ config, context, graph });

  const i18nWarnings = config.i18n ? i18nDiagnostics(pages, config.i18n) : [];

  return {
    config,
    context,
    diagnostics: [
      ...contentDiagnostics,
      ...folderMeta.diagnostics,
      ...graph.diagnostics,
      ...i18nWarnings,
    ],
    graph,
    manifest,
    mode,
    sources,
  };
};
