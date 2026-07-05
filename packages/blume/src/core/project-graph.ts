import { relative } from "pathe";

import { loadConfig } from "./config.ts";
import { buildContentGraph } from "./graph.ts";
import { i18nDiagnostics } from "./i18n.ts";
import {
  gitLastModifiedTimes,
  resolveLastModifiedConfig,
} from "./last-modified.ts";
import { buildManifest } from "./manifest.ts";
import { discoverFolderMeta } from "./meta.ts";
import type { FolderMetaSource } from "./meta.ts";
import { resolveProjectContext } from "./project.ts";
import type { ResolvedConfig } from "./schema.ts";
import { normalizeEntry } from "./sources/normalize.ts";
import { resolveDocsCollection, resolveSources } from "./sources/resolve.ts";
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

/** CLI-supplied overrides applied over the loaded config (see `scanProject`). */
export interface ConfigOverrides {
  /** Override `content.root` (`blume dev --content-dir`). */
  contentRoot?: string;
  /** Override `deployment.adapter` (`blume build --adapter`). */
  adapter?: ResolvedConfig["deployment"]["adapter"];
  /** Override `deployment.base` (`blume build --base`). */
  base?: string;
  /** Override `deployment.output` (`blume build --output`). */
  output?: ResolvedConfig["deployment"]["output"];
}

/** Apply CLI config overrides onto a resolved config (returns a new object). */
const applyConfigOverrides = (
  config: ResolvedConfig,
  overrides?: ConfigOverrides
): ResolvedConfig => {
  if (!overrides) {
    return config;
  }
  return {
    ...config,
    content: {
      ...config.content,
      root: overrides.contentRoot ?? config.content.root,
    },
    deployment: {
      ...config.deployment,
      adapter: overrides.adapter ?? config.deployment.adapter,
      base: overrides.base ?? config.deployment.base,
      output: overrides.output ?? config.deployment.output,
    },
  };
};

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
 * Guard the invariant that ties a filesystem page to the `docs` collection:
 * Astro ids each collection entry by its path relative to the collection base,
 * so `getEntry("docs", entryId)` only resolves when that entry id equals
 * `relative(base, file)`. A filesystem source ids entries relative to its own
 * root; when that root can't be the collection base (e.g. a second filesystem
 * source rooted elsewhere), the ids diverge and every one of that source's pages
 * would 404 in dev (a static build silently masks it). Emit a hard error naming
 * the mismatch so it can't ship, instead of a silent runtime failure. One
 * diagnostic per file (locale duplicates share a source path).
 */
const entryIdDiagnostics = (
  pages: PageRecord[],
  collectionBase: string
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    // Only filesystem entries render through the base-rooted `docs` collection;
    // staged sources carry their own id and collection.
    if (page.collection || !page.sourcePath || seen.has(page.sourcePath)) {
      continue;
    }
    seen.add(page.sourcePath);
    const expected = relative(collectionBase, page.sourcePath)
      .split("\\")
      .join("/");
    const entryId = page.entryId ?? page.source.ref;
    if (expected !== entryId) {
      diagnostics.push({
        code: "BLUME_ENTRY_ID_MISMATCH",
        file: page.sourcePath,
        message: `Content source "${page.source.name}" is rooted outside the docs collection base, so ${page.route} resolves entry id "${entryId}" but the collection would generate "${expected}" — the page would 404 at runtime.`,
        severity: "error",
        suggestion:
          "Give each filesystem source a root under content.root, or use a single filesystem source so the collection can root at it.",
      });
    }
  }
  return diagnostics;
};

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
    /** CLI overrides applied over the loaded config (e.g. `--output`). */
    overrides?: ConfigOverrides;
    /** Relocate the generated runtime (e.g. `.blume-verify` for isolation). */
    runtimeDir?: string;
  } = {}
): Promise<BlumeProject> => {
  const mode = options.mode ?? "dev";
  const preview = options.preview ?? false;
  const configResult = await loadConfig(root, {
    devServerUrl: options.devServerUrl,
  });
  const config = applyConfigOverrides(configResult.config, options.overrides);
  const context = resolveProjectContext(root, config, {
    runtimeDir: options.runtimeDir,
  });

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

  // Folder meta is discovered per filesystem source, under each source's own
  // root and keyed by its route prefix, so a prefixed/root-differing source's
  // `meta.ts` still lines up with its (prefixed) sidebar group path.
  const metaSources: FolderMetaSource[] = sources
    .filter((source) => !source.staged && source.contentRoot)
    .map((source) => ({
      prefix: source.prefix,
      root: source.contentRoot ?? "",
    }));

  // Run every source's `load()` in parallel, then funnel each entry through the
  // shared `normalizeEntry` so route mapping is identical regardless of origin.
  const [loaded, folderMeta] = await Promise.all([
    Promise.all(
      sources.map(async (source) => ({ source, ...(await source.load()) }))
    ),
    discoverFolderMeta(metaSources),
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
      ...entryIdDiagnostics(pages, resolveDocsCollection(config, context).base),
      ...graph.diagnostics,
      ...i18nWarnings,
    ],
    graph,
    manifest,
    mode,
    sources,
  };
};
