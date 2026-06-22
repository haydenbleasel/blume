import { existsSync } from "node:fs";

import { loadConfig } from "./config.ts";
import { discoverContent } from "./content.ts";
import { BlumeError } from "./diagnostics.ts";
import { buildContentGraph } from "./graph.ts";
import { buildManifest } from "./manifest.ts";
import { resolveProjectContext } from "./project.ts";
import type { ResolvedConfig } from "./schema.ts";
import type {
  BlumeManifest,
  ContentGraph,
  Diagnostic,
  ProjectContext,
} from "./types.ts";

/** Everything Blume knows about a project after a full scan. */
export interface BlumeProject {
  context: ProjectContext;
  config: ResolvedConfig;
  graph: ContentGraph;
  manifest: BlumeManifest;
  diagnostics: Diagnostic[];
}

/**
 * Run the full core pipeline for a project root: load config, resolve paths,
 * discover content, build the graph, and assemble the manifest. Collects all
 * diagnostics without throwing on content-level problems so callers can decide
 * how strict to be.
 */
export const scanProject = async (root: string): Promise<BlumeProject> => {
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

  const { pages, diagnostics: contentDiagnostics } = await discoverContent({
    contentRoot: context.contentRoot,
    defaultType: config.content.defaultType,
    exclude: config.content.exclude,
    include: config.content.include,
  });

  const graph = buildContentGraph(pages);
  const manifest = buildManifest({ config, context, graph });

  return {
    config,
    context,
    diagnostics: [...contentDiagnostics, ...graph.diagnostics],
    graph,
    manifest,
  };
};
