import { existsSync } from "node:fs";

import { rewriteMintlifySvgIconProps } from "../markdown/index.ts";
import { rewriteMintlifyGlobalVariables } from "../markdown/mintlify-snippets.ts";
import { loadConfig } from "./config.ts";
import { discoverContent } from "./content.ts";
import { BlumeError } from "./diagnostics.ts";
import { buildContentGraph } from "./graph.ts";
import {
  gitLastModifiedTimes,
  resolveLastModifiedConfig,
} from "./last-modified.ts";
import { buildManifest } from "./manifest.ts";
import { discoverFolderMeta } from "./meta.ts";
import { resolveProjectContext } from "./project.ts";
import type { ResolvedConfig } from "./schema.ts";
import type {
  BlumeManifest,
  ContentGraph,
  Diagnostic,
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
}

const mintlifySourceTransform = (
  context: ProjectContext,
  config: ResolvedConfig
): ((source: string) => string) | undefined => {
  if (context.configFile?.endsWith("docs.json") !== true) {
    return undefined;
  }
  return (source) => {
    const withSvgIcons = rewriteMintlifySvgIconProps(source);
    return rewriteMintlifyGlobalVariables(withSvgIcons, config.variables);
  };
};

/**
 * Run the full core pipeline for a project root: load config, resolve paths,
 * discover content and folder meta, build the graph, and assemble the manifest.
 * Collects all diagnostics without throwing on content-level problems so
 * callers can decide how strict to be.
 */
export const scanProject = async (
  root: string,
  options: { mode?: BuildMode } = {}
): Promise<BlumeProject> => {
  const mode = options.mode ?? "dev";
  const { config } = await loadConfig(root);
  const context = resolveProjectContext(root, config);

  if (!existsSync(context.contentRoot)) {
    throw new BlumeError({
      code: "BLUME_CONTENT_ROOT_MISSING",
      file: context.contentRoot,
      message: `Content root not found: ${config.content.root}`,
      severity: "error",
      suggestion: `Create a "${config.content.root}" folder with at least one .md or .mdx file, or set content.root in blume.config.ts.`,
    });
  }

  const contentRoots = [context.contentRoot];

  const [contentResults, folderMeta] = await Promise.all([
    Promise.all(
      contentRoots.map((contentRoot) =>
        discoverContent({
          contentRoot,
          defaultType: config.content.defaultType,
          exclude: config.content.exclude,
          include: config.content.include,
          transformSource: mintlifySourceTransform(context, config),
        })
      )
    ),
    discoverFolderMeta(context.contentRoot),
  ]);
  const content = {
    diagnostics: contentResults.flatMap((result) => result.diagnostics),
    pages: contentResults.flatMap((result) => result.pages),
  };

  // Drafts render in dev but are excluded from production builds.
  const pages =
    mode === "build"
      ? content.pages.filter((page) => !page.meta.draft)
      : content.pages;

  // Resolve "last updated" dates before the graph is built so the manifest
  // (which shares these page objects) picks them up. Frontmatter always wins;
  // git provides the rest when enabled.
  const lastModified = resolveLastModifiedConfig(config.lastModified);
  if (lastModified.enabled) {
    const gitTimes =
      lastModified.source === "git"
        ? gitLastModifiedTimes(
            context.root,
            context.contentRoot,
            pages.map((page) => page.sourcePath)
          )
        : new Map<string, string>();
    for (const page of pages) {
      page.lastModified =
        page.meta.lastModified ?? gitTimes.get(page.sourcePath);
    }
  }

  const graph = buildContentGraph(pages, {
    folderMeta: folderMeta.meta,
    navigation: config.navigation,
  });
  const manifest = buildManifest({ config, context, graph });

  return {
    config,
    context,
    diagnostics: [
      ...content.diagnostics,
      ...folderMeta.diagnostics,
      ...graph.diagnostics,
    ],
    graph,
    manifest,
    mode,
  };
};
