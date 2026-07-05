import { isAbsolute, join, resolve } from "pathe";

import { blumeReferences } from "../../openapi/references.ts";
import { openApiSource } from "../../openapi/source.ts";
import type { ContentSourceConfig, ResolvedConfig } from "../schema.ts";
import type { ProjectContext } from "../types.ts";
import { filesystemSource } from "./filesystem.ts";
import { githubReleasesSource } from "./github-releases.ts";
import { mdxRemoteSource } from "./mdx-remote.ts";
import { notionSource } from "./notion.ts";
import { sanitySource } from "./sanity.ts";
import type { ContentSource, SourceContext } from "./types.ts";

/** Allocate a unique, stable source name from a base (prefix or type). */
const uniqueNamer = (): ((base: string) => string) => {
  const used = new Set<string>();
  return (base) => {
    let name = base;
    let n = 2;
    while (used.has(name)) {
      name = `${base}-${n}`;
      n += 1;
    }
    used.add(name);
    return name;
  };
};

/** Runtime knobs for a scan: dev/build mode, preview, and cache refresh. */
export interface SourceRuntime {
  mode: "dev" | "build";
  preview?: boolean;
  refresh?: boolean;
}

const sourceContext = (
  context: ProjectContext,
  name: string,
  runtime: SourceRuntime
): SourceContext => ({
  assetsBaseUrl: `/blume-assets/${name}`,
  assetsDir: join(context.outDir, "public", "blume-assets", name),
  cacheDir: join(context.outDir, "cache", name),
  mode: runtime.mode,
  preview: runtime.preview,
  projectRoot: context.root,
  refresh: runtime.refresh ?? runtime.mode === "build",
});

const buildSource = (
  def: ContentSourceConfig,
  name: string,
  context: ProjectContext,
  runtime: SourceRuntime
): ContentSource => {
  if (def.type === "filesystem") {
    return filesystemSource({
      exclude: def.exclude,
      include: def.include,
      name,
      prefix: def.prefix,
      projectRoot: context.root,
      root: def.root,
    });
  }
  if (def.type === "custom") {
    // A user-provided instance manages its own context/caching; we only ensure
    // its name is unique across the project for id namespacing.
    return def.source.name === name ? def.source : { ...def.source, name };
  }
  if (def.type === "sanity") {
    return sanitySource(
      {
        apiVersion: def.apiVersion,
        dataset: def.dataset,
        fields: def.fields,
        name,
        pollInterval: def.pollInterval,
        prefix: def.prefix,
        projectId: def.projectId,
        query: def.query,
      },
      sourceContext(context, name, runtime)
    );
  }
  if (def.type === "notion") {
    return notionSource(
      {
        database: def.database,
        name,
        pollInterval: def.pollInterval,
        prefix: def.prefix,
        properties: def.properties,
        publishedValue: def.publishedValue,
      },
      sourceContext(context, name, runtime)
    );
  }
  if (def.type === "github-releases") {
    return githubReleasesSource(
      {
        drafts: def.drafts,
        limit: def.limit,
        name,
        owner: def.owner,
        pollInterval: def.pollInterval,
        prefix: def.prefix,
        prereleases: def.prereleases,
        repo: def.repo,
      },
      sourceContext(context, name, runtime)
    );
  }
  return mdxRemoteSource(
    {
      files: def.files,
      github: def.github,
      include: def.include,
      name,
      pollInterval: def.pollInterval,
      prefix: def.prefix,
      url: def.url,
    },
    sourceContext(context, name, runtime)
  );
};

/** Resolve a source `root` against the project root (absolute passes through). */
const resolveRoot = (projectRoot: string, root: string): string =>
  isAbsolute(root) ? root : join(resolve(projectRoot), root);

/**
 * The generated `docs` glob collection: its base directory and the include /
 * exclude globs applied under it. Astro's glob loader ids each entry by its path
 * relative to `base`, and a filesystem source ids each entry relative to its own
 * root — so the two only agree when the collection is rooted at that source. A
 * project with exactly one filesystem source therefore roots the collection at
 * *that* source (honoring a non-default `root`), rather than the global
 * `content.root`. With no sources (the implicit source) or several, the base
 * stays `content.root`; a second filesystem source rooted elsewhere can't share
 * one base and is caught by the entry-id guard in `scanProject`.
 */
export interface DocsCollection {
  base: string;
  include: string[];
  exclude: string[];
}

export const resolveDocsCollection = (
  config: ResolvedConfig,
  context: ProjectContext
): DocsCollection => {
  const filesystem = (config.content.sources ?? []).filter(
    (def) => def.type === "filesystem"
  );
  const only = filesystem.length === 1 ? filesystem[0] : undefined;
  if (only) {
    return {
      base: resolveRoot(context.root, only.root),
      exclude: only.exclude,
      include: only.include,
    };
  }
  return {
    base: context.contentRoot,
    exclude: config.content.exclude,
    include: config.content.include,
  };
};

/** The base name to allocate for a source config (before deduplication). */
const baseName = (def: ContentSourceConfig): string => {
  if (def.type === "custom") {
    return def.source.name;
  }
  return def.prefix ?? def.type;
};

/** The content sources declared by config (implicit filesystem when none). */
const contentSources = (
  config: ResolvedConfig,
  context: ProjectContext,
  runtime: SourceRuntime
): ContentSource[] => {
  const defs = config.content.sources;
  if (!defs || defs.length === 0) {
    return [
      filesystemSource({
        exclude: config.content.exclude,
        include: config.content.include,
        name: "filesystem",
        projectRoot: context.root,
        root: config.content.root,
      }),
    ];
  }

  const nameFor = uniqueNamer();
  return defs.map((def) =>
    buildSource(def, nameFor(baseName(def)), context, runtime)
  );
};

/**
 * Build the ordered list of content sources for a project. With no
 * `content.sources` configured, the top-level `root`/`include`/`exclude` desugar
 * to a single implicit filesystem source, so existing projects are untouched.
 * A Blume-rendered OpenAPI reference contributes an internal staged source that
 * lowers each operation into a real content page (routing/nav/search/OG).
 */
export const resolveSources = (
  config: ResolvedConfig,
  context: ProjectContext,
  runtime: SourceRuntime
): ContentSource[] => {
  const sources = contentSources(config, context, runtime);

  const references = blumeReferences(config);
  if (references.length > 0) {
    sources.push(
      openApiSource(references, sourceContext(context, "openapi", runtime))
    );
  }

  return sources;
};
