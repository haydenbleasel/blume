import { isAbsolute, join, resolve } from "pathe";

import {
  DEFAULT_CONTENT_EXCLUDE,
  DEFAULT_CONTENT_INCLUDE,
} from "../../sources/filesystem.ts";
import type { ContentSourceAdapter } from "../../sources/registry.ts";
import type { ResolvedConfig } from "../schema.ts";

/** Resolve a source `root` against the project root (absolute passes through). */
export const resolveSourceRoot = (projectRoot: string, root: string): string =>
  isAbsolute(root) ? root : join(resolve(projectRoot), root);

/** The configured sources of one adapter `kind`, in config order. */
export const sourcesOfKind = <Kind extends ContentSourceAdapter["kind"]>(
  config: ResolvedConfig,
  kind: Kind
): Extract<ContentSourceAdapter, { kind: Kind }>[] =>
  config.content.sources.filter(
    (source): source is Extract<ContentSourceAdapter, { kind: Kind }> =>
      source.kind === kind
  );

/**
 * The generated `docs` glob collection: its base directory and the include /
 * exclude globs applied under it. Astro's glob loader ids each entry by its
 * path relative to `base`, and a filesystem source ids each entry relative to
 * its own root — so the two only agree when the collection is rooted at that
 * source. The collection therefore roots at the first `filesystem()` source
 * (the implicit one, for a zero-config project). Further filesystem sources
 * must share that root and partition it with globs: every filesystem source's
 * `include` feeds the collection, and only a pattern every one of them
 * excludes is excluded, so no source's pages are globbed away. A source
 * rooted elsewhere can't share the base and is caught by the entry-id guard in
 * `scanProject`. With no filesystem source at all the collection globs nothing
 * and its base is the default `docs` directory, which only anchors paths.
 */
export interface DocsCollection {
  base: string;
  include: string[];
  exclude: string[];
}

export const resolveDocsCollection = (
  config: ResolvedConfig,
  projectRoot: string
): DocsCollection => {
  const [first, ...rest] = sourcesOfKind(config, "filesystem");
  if (!first) {
    return {
      base: resolveSourceRoot(projectRoot, "docs"),
      exclude: DEFAULT_CONTENT_EXCLUDE,
      include: DEFAULT_CONTENT_INCLUDE,
    };
  }
  const include = [
    ...new Set([first, ...rest].flatMap((source) => source.options.include)),
  ];
  const exclude = first.options.exclude.filter((pattern) =>
    rest.every((source) => source.options.exclude.includes(pattern))
  );
  return {
    base: resolveSourceRoot(projectRoot, first.options.root),
    exclude,
    include,
  };
};
