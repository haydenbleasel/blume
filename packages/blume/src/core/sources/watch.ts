import type { WatchListener } from "node:fs";

/**
 * Directory segments that are never authored content: VCS, dependency trees,
 * Blume's own generated project and build output, and framework/deploy caches.
 * Both the content scan and the dev watcher skip these unconditionally, on top
 * of the user's `content.exclude`.
 *
 * The scan needs them because a broadly-scoped `content.root` — `"."` or an app
 * dir that also holds `node_modules`/`dist`, the common shape when migrating a
 * docs app that lives at the repo or app root — would otherwise glob thousands
 * of stray markdown files out of dependencies and build artifacts. `content.root`
 * defaults to `docs/` where this rarely bites, but any wider root hits it.
 *
 * The watcher needs them because a recursive `fs.watch` rooted at the project
 * also sees Blume's own `.blume/` output, which the dev server rewrites on every
 * render (e.g. `.blume/.astro/data-store.json`). Left unfiltered, each such write
 * re-triggers a rescan + runtime regeneration whose writes land back under
 * `.blume/` and fire the watcher again: a self-sustaining loop that stalls page
 * renders and floods the console (and, mid-render, corrupts Astro's dev module
 * graph so `astro:server-app.js` fails to load). `fs.watch` has no ignore
 * option, so we filter by the changed path in the callback.
 */
export const BLUME_IGNORE_DIRS = [
  ".blume",
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "dist",
  "node_modules",
];

/**
 * Baseline scan-ignore globs applied to every filesystem source, unioned with
 * the user's `content.exclude`. Kept in sync with the watcher via the shared
 * {@link BLUME_IGNORE_DIRS} so `load()` and `watch()` never disagree on what is
 * content. `**\/<dir>/**` matches the directory at the content root or nested.
 */
export const baselineScanIgnore = (): string[] =>
  BLUME_IGNORE_DIRS.map((dir) => `**/${dir}/**`);

/**
 * Alias retained for the dev watcher's call site and its tests; the watcher and
 * the scan share the same never-content directory set.
 */
export const BLUME_WATCH_IGNORE_DIRS = BLUME_IGNORE_DIRS;

/** Extract single-segment ignore dirs (`foo`) from `foo/**`-style excludes. */
export const excludeDirSegments = (patterns: readonly string[]): string[] =>
  patterns
    .map((pattern) => /^(?<dir>[^*/]+)\/\*\*$/u.exec(pattern)?.groups?.dir)
    .filter((dir): dir is string => dir !== undefined);

/**
 * Build a recursive-watch listener that fires `onChange` for content changes but
 * ignores events whose path crosses an ignored directory segment. A missing
 * `filename` — rare; the platform couldn't name the changed path — falls through
 * to `onChange` rather than silently dropping a real edit. Exported for testing.
 */
export const ignoringWatchListener = (
  onChange: () => void,
  ignoreDirs: Iterable<string> = BLUME_WATCH_IGNORE_DIRS
): WatchListener<string> => {
  const ignore = new Set(ignoreDirs);
  return (_event, filename) => {
    if (
      typeof filename === "string" &&
      filename.split(/[/\\]/u).some((segment) => ignore.has(segment))
    ) {
      return;
    }
    onChange();
  };
};
