import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { normalize, relative } from "pathe";

import type { Diagnostic } from "./types.ts";

/** Normalized form of the `lastModified` config. */
export interface ResolvedLastModified {
  enabled: boolean;
  source: "git" | "frontmatter";
}

/**
 * Env for git invocations, with the repo-locating GIT_* variables stripped. A
 * parent git process exports an absolute GIT_DIR (and friends) to its hooks —
 * husky pre-commit in a linked worktree, post-merge, CI wrappers — and an
 * inherited GIT_DIR overrides `-C` discovery, silently pointing every call at
 * the parent's repository instead of the project's.
 */
const GIT_LOCATION_VARS = new Set([
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
]);

export const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !GIT_LOCATION_VARS.has(key))
  );

/** Normalize the `lastModified` config (`false | "git" | "frontmatter"`) into `{ enabled, source }`. */
export const resolveLastModifiedConfig = (
  value: false | "git" | "frontmatter"
): ResolvedLastModified =>
  value === false
    ? { enabled: false, source: "git" }
    : { enabled: true, source: value };

/** Each file's git dates, keyed by path. */
export interface GitDates {
  /** The committer ISO date of the newest commit that changed the file. */
  modified: Map<string, string>;
  /** The committer ISO date of the commit that added the file. */
  published: Map<string, string>;
}

/**
 * Parse `git log --format=%x00%cI --name-status -M100%` output into each
 * repo-root-relative path's dates. Each commit emits a NUL-prefixed date line
 * followed by a status line per path it touched (`M\tpath`, `R100\told\tnew`);
 * since git logs newest-first, the first date seen for a path is when it last
 * changed, and the add (`A\tpath`) that ends its history is when it was
 * published. Blank lines are ignored.
 *
 * A rename (`-M100%` reports only exact ones, where the content is unchanged)
 * follows the file the way `git log --follow` does for one path: it dates
 * nothing itself, and the older commits that name the old path date the file
 * under its current name, so renaming `page.md` to `page.mdx` keeps the page's
 * dates. A file whose visible history starts at a rename (a shallow clone cut
 * off the commits before it) takes the rename's date. Only exact renames are
 * followed: `--follow`'s default 50% similarity would hand a new page the
 * history of a similar one deleted in the same commit.
 */
export const parseGitLog = (output: string): GitDates => {
  const modified = new Map<string, string>();
  const published = new Map<string, string>();
  // An older name of a file → its name now, for the commits read after the
  // rename (older ones).
  const currentNames = new Map<string, string>();
  const renamedAt = new Map<string, string>();
  // Files whose add has been read: anything older under the same name was an
  // earlier file at that path, deleted before this one was created.
  const added = new Set<string>();
  let current: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("\0")) {
      current = line.slice(1);
      continue;
    }
    const [status = "", from = "", to] = line.split("\t");
    const path = to ?? from;
    if (!(current && path)) {
      continue;
    }
    const name = currentNames.get(path) ?? path;
    if (!added.has(name)) {
      published.set(name, current);
      if (status === "A") {
        added.add(name);
      }
    }
    if (status.startsWith("R")) {
      currentNames.set(from, name);
      if (!renamedAt.has(name)) {
        renamedAt.set(name, current);
      }
    } else if (!modified.has(name)) {
      modified.set(name, current);
    }
  }
  for (const [name, date] of renamedAt) {
    if (!modified.has(name)) {
      modified.set(name, date);
    }
  }
  return { modified, published };
};

/**
 * `path` with every symlink resolved, the spelling git prints paths in: a
 * project opened through a link (`/tmp/site` on macOS, where `/tmp` links to
 * `/private/tmp`) gets `/private/tmp/site` from `rev-parse --show-toplevel`,
 * so the project's own spelling would compare as outside the repository and
 * every page would go undated. The native realpath also expands a Windows
 * 8.3 short name (`RUNNER~1`), which git does too. A path that doesn't exist
 * stays as written.
 */
export const realPath = (path: string): string => {
  try {
    return normalize(realpathSync.native(path));
  } catch {
    return path;
  }
};

/**
 * The toplevel of the repository containing `root`, or null when git is
 * unavailable or the project isn't a repo. Callers use it to decide which
 * content roots a `git log` pathspec can cover at all — a root outside the
 * repository would fail the log outright and can never yield dates.
 */
export const gitRepositoryRoot = (root: string): string | null => {
  try {
    return execFileSync(
      // oxlint-disable-next-line sonarjs/no-os-command-from-path -- git is a required dev-tool dependency resolved from PATH
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      // stderr silenced: outside a repository the probe fails by design.
      { encoding: "utf-8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return null;
  }
};

const noDates = (): GitDates => ({ modified: new Map(), published: new Map() });

/**
 * Resolve each source file's git dates (see `parseGitLog`), keyed by absolute
 * source path. Runs a single `git log` over the given content roots (each
 * local source's own root, which may diverge from `content.root`), following
 * renames within them (a file moved in from outside every root dates from the
 * move), and maps repo-root-relative paths back to the given absolute paths
 * (monorepo-safe via `rev-parse --show-toplevel`). Returns empty maps if git
 * is unavailable or the project isn't a repo — the features then simply show
 * no dates.
 */
export const gitFileDates = (
  root: string,
  contentRoots: string[],
  sourcePaths: string[],
  repositoryRoot?: string | null
): GitDates => {
  // Nothing to date, or nowhere bounded to look — either way, don't pay for a
  // git scan. Both guards matter: `git log -- ` with no pathspec logs the
  // entire repository, which is what an all-staged project produces (a staged
  // source contributes no content root, yet its entries can still carry a
  // `sourcePath`).
  if (sourcePaths.length === 0 || contentRoots.length === 0) {
    return noDates();
  }
  // The caller that bounded `contentRoots` already resolved the repo root;
  // reuse it rather than spawning `rev-parse` a second time per scan.
  const gitRoot =
    repositoryRoot === undefined ? gitRepositoryRoot(root) : repositoryRoot;
  if (gitRoot === null) {
    return noDates();
  }
  // Git names paths by their real location, so the pathspecs and the paths
  // read back against the log are compared in that spelling too (see
  // `realPath`).
  const top = realPath(gitRoot);
  try {
    const output = execFileSync(
      // oxlint-disable-next-line sonarjs/no-os-command-from-path -- git is a required dev-tool dependency resolved from PATH
      "git",
      [
        "-C",
        root,
        "-c",
        "core.quotePath=false",
        "log",
        "--format=%x00%cI",
        "--name-status",
        // Exact renames only: git pairs them by blob id without comparing
        // contents, so following them costs nothing, and a rename with edits
        // dates the file at that commit either way.
        "-M100%",
        "--",
        ...contentRoots.map(realPath),
      ],
      { encoding: "utf-8", env: gitEnv(), maxBuffer: 256 * 1024 * 1024 }
    );
    const byRepoPath = parseGitLog(output);
    const result = noDates();
    for (const sourcePath of sourcePaths) {
      const repoPath = relative(top, realPath(sourcePath));
      for (const key of ["modified", "published"] as const) {
        const iso = byRepoPath[key].get(repoPath);
        if (iso) {
          result[key].set(sourcePath, iso);
        }
      }
    }
    return result;
  } catch {
    return noDates();
  }
};

/**
 * Whether the repository containing `root` is a shallow clone. Returns false
 * when git is unavailable or the project isn't a repo — those cases already
 * yield no dates at all, and the shallow warning would only mislead.
 */
export const isShallowGitRepository = (root: string): boolean => {
  try {
    return (
      execFileSync(
        // oxlint-disable-next-line sonarjs/no-os-command-from-path -- git is a required dev-tool dependency resolved from PATH
        "git",
        ["-C", root, "rev-parse", "--is-shallow-repository"],
        // stderr silenced: outside a repository the probe fails by design.
        {
          encoding: "utf-8",
          env: gitEnv(),
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).trim() === "true"
    );
  } catch {
    return false;
  }
};

const SHALLOW_CLONE_SUGGESTION =
  "Fetch full history in CI: set the VERCEL_DEEP_CLONE=true environment variable on Vercel, or fetch-depth: 0 for actions/checkout.";

/**
 * A warning for git-derived dates silently missing because the build ran in a
 * shallow clone — the default on Vercel and `actions/checkout`, where `git log`
 * only sees the last few commits, so most pages get no date and the sitemap's
 * `<lastmod>` / "Last updated" stamps quietly disappear in production while
 * working locally. Empty when every page got a date or the clone isn't
 * shallow.
 */
export const lastModifiedShallowWarning = (
  root: string,
  undatedCount: number
): Diagnostic[] => {
  if (undatedCount === 0 || !isShallowGitRepository(root)) {
    return [];
  }
  return [
    {
      code: "BLUME_SHALLOW_GIT_HISTORY",
      message: `lastModified is on, but this build runs in a shallow git clone, so ${undatedCount} page(s) have no git-derived date — their sitemap <lastmod> and "Last updated" stamps are omitted.`,
      severity: "warning",
      suggestion: SHALLOW_CLONE_SUGGESTION,
    },
  ];
};

/**
 * The warning for `seo.datePublished: "git"` in a shallow clone, where the
 * oldest commit git can see is where the clone was cut, not where each page
 * began. Git then dates no page rather than every page wrongly. Empty when
 * every page has a front matter date.
 */
export const datePublishedShallowWarning = (
  undatedCount: number
): Diagnostic[] =>
  undatedCount === 0
    ? []
    : [
        {
          code: "BLUME_SHALLOW_GIT_HISTORY",
          message: `seo.datePublished is "git", but this build runs in a shallow git clone, so ${undatedCount} page(s) without a front matter date have no datePublished.`,
          severity: "warning",
          suggestion: SHALLOW_CLONE_SUGGESTION,
        },
      ];
