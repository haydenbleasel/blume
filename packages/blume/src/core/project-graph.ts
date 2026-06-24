import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import { isAbsolute, join, relative, resolve } from "pathe";

import { generateAsyncApiDocs, parseAsyncApi } from "../asyncapi/import.ts";
import {
  rewriteMintlifyAsyncApiPage,
  rewriteMintlifyManualApiPage,
  rewriteMintlifyOpenApiSchemaPage,
  rewriteMintlifySvgIconProps,
} from "../markdown/index.ts";
import { rewriteMintlifyGlobalVariables } from "../markdown/mintlify-snippets.ts";
import { generateApiDocs, parseOpenApi } from "../openapi/import.ts";
import { loadConfig } from "./config.ts";
import { discoverContent } from "./content.ts";
import { BlumeError } from "./diagnostics.ts";
import { buildContentGraph } from "./graph.ts";
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

const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const resolveApiSource = (
  context: ProjectContext,
  source: string,
  type: "AsyncAPI" | "OpenAPI"
): string => {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return source;
  }

  const mintlifyRootRelative =
    context.configFile?.endsWith("docs.json") === true &&
    source.startsWith("/");
  let target = join(context.root, source);
  if (mintlifyRootRelative) {
    target = join(context.root, source.slice(1));
  } else if (isAbsolute(source)) {
    target = source;
  }
  const absolute = resolve(target);
  if (!isInsideRoot(context.root, absolute)) {
    throw new BlumeError({
      code: `BLUME_${type.toUpperCase()}_OUTSIDE_ROOT`,
      file: source,
      message: `${type} source points outside the project root: ${source}`,
      severity: "error",
    });
  }
  return absolute;
};

const generateApiContent = async (
  context: ProjectContext,
  config: ResolvedConfig
): Promise<string | null> => {
  const generatedRoot = context.generatedContentRoot;
  if (
    !generatedRoot ||
    (config.api.openapi.length === 0 && config.api.asyncapi.length === 0)
  ) {
    return null;
  }

  await rm(generatedRoot, { force: true, recursive: true });
  await Promise.all([
    ...config.api.openapi.map(async (spec) => {
      const doc = await parseOpenApi(
        resolveApiSource(context, spec.source, "OpenAPI")
      );
      await generateApiDocs(doc, join(generatedRoot, spec.directory), {
        examples: config.api.examples,
        params: config.api.params,
        rootDir: generatedRoot,
      });
    }),
    ...config.api.asyncapi.map(async (spec) => {
      const doc = await parseAsyncApi(
        resolveApiSource(context, spec.source, "AsyncAPI")
      );
      await generateAsyncApiDocs(doc, join(generatedRoot, spec.directory));
    }),
  ]);
  return generatedRoot;
};

const mintlifySourceTransform = (
  context: ProjectContext,
  config: ResolvedConfig
): ((source: string, file: string) => Promise<string> | string) | undefined => {
  if (context.configFile?.endsWith("docs.json") !== true) {
    return undefined;
  }
  return async (source, file) => {
    const withSvgIcons = rewriteMintlifySvgIconProps(source);
    const withSchema = await rewriteMintlifyOpenApiSchemaPage(withSvgIcons, {
      filePath: file,
      generation: {
        examples: config.api.examples,
        params: config.api.params,
      },
      root: context.root,
      specs: config.api.openapi,
    });
    const withManualApi = rewriteMintlifyManualApiPage(withSchema, {
      api: config.api,
    });
    const withAsyncApi = await rewriteMintlifyAsyncApiPage(withManualApi, {
      root: context.root,
      specs: config.api.asyncapi,
    });
    return rewriteMintlifyGlobalVariables(withAsyncApi, config.variables);
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

  const generatedApiContentRoot = await generateApiContent(context, config);
  const contentRoots = [context.contentRoot];
  if (generatedApiContentRoot) {
    contentRoots.push(generatedApiContentRoot);
  }

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
