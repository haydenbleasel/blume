import { existsSync, watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";

import { extname, isAbsolute, join, relative, resolve } from "pathe";
import { glob } from "tinyglobby";

import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import type { ContentSource, SourceEntry, SourceLoadResult } from "./types.ts";
import {
  baselineScanIgnore,
  BLUME_WATCH_IGNORE_DIRS,
  excludeDirSegments,
  ignoringWatchListener,
} from "./watch.ts";

/** Options for the built-in filesystem source. */
export interface FilesystemSourceOptions {
  /** Stable source name; namespaces ids and diagnostics. */
  name: string;
  /** Optional route prefix. */
  prefix?: string;
  /** Content root, absolute or relative to `projectRoot`. */
  root: string;
  include: string[];
  exclude: string[];
  /** Absolute project root, used to resolve a relative `root`. */
  projectRoot: string;
  /** When set, a missing root throws this code instead of the generic one. */
  missingCode?: string;
}

/**
 * The built-in content source: discover and read `.md`/`.mdx` files under a
 * content root. This is the extraction of the original `discoverContent()` scan
 * into a `ContentSource`; every other adapter follows the same contract.
 */
export const filesystemSource = (
  options: FilesystemSourceOptions
): ContentSource & { readonly contentRoot: string } => {
  const contentRoot = isAbsolute(options.root)
    ? options.root
    : join(resolve(options.projectRoot), options.root);

  const load = async (): Promise<SourceLoadResult> => {
    const files = await glob(options.include, {
      absolute: true,
      cwd: contentRoot,
      // Union the user's `exclude` with the baseline never-content dirs so a
      // broadly-scoped root (`.` or an app dir) can't glob `node_modules`,
      // `dist`, `.blume`, etc. — even when the user overrode `exclude`.
      ignore: [...options.exclude, ...baselineScanIgnore()],
      onlyFiles: true,
    });
    files.sort();

    const entries = await Promise.all(
      files.map(async (file): Promise<SourceEntry> => {
        const source = await readFile(file, "utf-8");
        const ext = extname(file).toLowerCase();
        const format = ext === ".mdx" ? "mdx" : "md";
        const parsed = matter(source);
        return {
          body: { format, text: parsed.content },
          data: parsed.data,
          ref: relative(contentRoot, file),
          sourcePath: file,
        };
      })
    );

    return { diagnostics: [], entries };
  };

  const validate = (): void => {
    if (!existsSync(contentRoot)) {
      throw new BlumeError({
        code: options.missingCode ?? "BLUME_CONTENT_ROOT_MISSING",
        file: contentRoot,
        message: `Content root not found: ${options.root}`,
        severity: "error",
        suggestion: `Create a "${options.root}" folder with at least one .md or .mdx file, or set content.root in blume.config.ts.`,
      });
    }
  };

  // When `content.root` is the project root (a migrated `.`-rooted project),
  // the recursive dev watcher would otherwise see Blume's own `.blume/` output
  // and loop; skip it, VCS/dependency trees, and every excluded dir so the
  // watcher stays in sync with what `load()` globs. See {@link ignoringWatchListener}.
  const watchIgnoreDirs = new Set([
    ...BLUME_WATCH_IGNORE_DIRS,
    ...excludeDirSegments(options.exclude),
  ]);

  const watch = (onChange: () => void): (() => void) => {
    if (!existsSync(contentRoot)) {
      return () => {
        // Nothing to dispose when the root doesn't exist yet.
      };
    }
    const watcher = fsWatch(
      contentRoot,
      { recursive: true },
      ignoringWatchListener(onChange, watchIgnoreDirs)
    );
    return () => watcher.close();
  };

  return {
    contentRoot,
    load,
    name: options.name,
    prefix: options.prefix,
    read: (ref: string): Promise<string> =>
      readFile(join(contentRoot, ref), "utf-8"),
    staged: false,
    validate,
    watch,
  };
};
