import { join } from "pathe";

import { blumeReferences } from "../../openapi/references.ts";
import { openApiSource } from "../../openapi/source.ts";
import type { ContentSourceAdapter } from "../../sources/registry.ts";
import type { ResolvedConfig } from "../schema.ts";
import type { ProjectContext } from "../types.ts";
import { filesystemSource } from "./filesystem.ts";
import { githubReleasesSource } from "./github-releases.ts";
import { mdxRemoteSource } from "./mdx-remote.ts";
import { notionSource } from "./notion.ts";
import { obsidianSource } from "./obsidian.ts";
import { sanitySource } from "./sanity.ts";
import type { ContentSource, SourceContext } from "./types.ts";

export {
  resolveDocsCollection,
  resolveSourceRoot,
  sourcesOfKind,
} from "./collection.ts";
export type { DocsCollection } from "./collection.ts";

/** Allocate a unique, stable source name from a base (prefix or kind). */
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

/**
 * The frontmatter keys each content type declares (`content.types[*].frontmatter`),
 * keyed by type — so a source that drops unknown keys keeps, per note, exactly
 * the ones `normalizeEntry` will accept for that note's type.
 */
const typeFrontmatterKeys = (
  config: ResolvedConfig
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(config.content.types).map(([type, def]) => [
      type,
      Object.keys(def.frontmatter),
    ])
  );

/**
 * Instantiate the engine-side source for a descriptor. Each adapter's options
 * spread straight into its engine factory: the descriptor carries exactly the
 * fields the factory documents, plus the shared `prefix`/`pollInterval`.
 */
const buildSource = (
  adapter: ContentSourceAdapter,
  name: string,
  config: ResolvedConfig,
  context: ProjectContext,
  runtime: SourceRuntime
): ContentSource => {
  switch (adapter.kind) {
    case "filesystem": {
      const { pollInterval: _ignored, ...options } = adapter.options;
      return filesystemSource({ ...options, name, projectRoot: context.root });
    }
    case "custom": {
      // A user-provided instance manages its own context/caching; we only ensure
      // its name is unique across the project for id namespacing.
      const source = adapter.options;
      return source.name === name ? source : { ...source, name };
    }
    case "sanity": {
      return sanitySource(
        { ...adapter.options, name },
        sourceContext(context, name, runtime)
      );
    }
    case "notion": {
      return notionSource(
        { ...adapter.options, name },
        sourceContext(context, name, runtime)
      );
    }
    case "obsidian": {
      const { pollInterval: _ignored, ...options } = adapter.options;
      return obsidianSource(
        {
          ...options,
          defaultType: config.content.defaultType,
          frontmatterKeys: Object.keys(config.frontmatter.extend),
          i18n: config.i18n,
          name,
          typeFrontmatterKeys: typeFrontmatterKeys(config),
          versions: config.versions,
        },
        sourceContext(context, name, runtime)
      );
    }
    case "github-releases": {
      return githubReleasesSource(
        { ...adapter.options, name },
        sourceContext(context, name, runtime)
      );
    }
    default: {
      // Only `mdx-remote` is left, and TypeScript has narrowed `adapter` to it.
      // It returns after the switch rather than from a last case block: Bun
      // 1.4.0's line coverage never credits the closing brace of a switch's
      // final block, which would fail the 100% gate in CI.
      break;
    }
  }
  return mdxRemoteSource(
    { ...adapter.options, name },
    sourceContext(context, name, runtime)
  );
};

/** The base name to allocate for a descriptor (before deduplication). */
const baseName = (adapter: ContentSourceAdapter): string => {
  if (adapter.kind === "custom") {
    return adapter.options.name;
  }
  return adapter.options.prefix ?? adapter.kind;
};

/**
 * Build the ordered list of content sources for a project. The config schema
 * already desugared the zero-config shorthand into a single `filesystem()`
 * descriptor, so every project has at least one entry here. A Blume-rendered
 * OpenAPI reference contributes an internal staged source that lowers each
 * operation into a real content page (routing/nav/search/OG).
 */
export const resolveSources = (
  config: ResolvedConfig,
  context: ProjectContext,
  runtime: SourceRuntime
): ContentSource[] => {
  const nameFor = uniqueNamer();
  const sources = config.content.sources.map((adapter) =>
    buildSource(adapter, nameFor(baseName(adapter)), config, context, runtime)
  );

  const references = blumeReferences(config);
  if (references.length > 0) {
    sources.push(
      openApiSource(references, sourceContext(context, "openapi", runtime))
    );
  }

  return sources;
};
