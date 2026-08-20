import { execFileSync } from "node:child_process";

import { relative } from "pathe";

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

const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !GIT_LOCATION_VARS.has(key))
  );

/** Normalize the `lastModified` config union into `{ enabled, source }`. */
export const resolveLastModifiedConfig = (
  value: boolean | { type: "git" | "frontmatter" }
): ResolvedLastModified => {
  if (value === false) {
    return { enabled: false, source: "git" };
  }
  if (value === true) {
    return { enabled: true, source: "git" };
  }
  return { enabled: true, source: value.type };
};

/**
 * Parse `git log --format=%x00%cI --name-only` output into a map of
 * repo-root-relative path → most recent committer ISO date. Each commit emits a
 * NUL-prefixed date line followed by the paths it touched; since git logs
 * newest-first, the first date seen for a path wins. Blank lines are ignored.
 */
export const parseGitLog = (output: string): Map<string, string> => {
  const times = new Map<string, string>();
  let current: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("\0")) {
      current = line.slice(1);
    } else if (line && current && !times.has(line)) {
      times.set(line, current);
    }
  }
  return times;
};

/**
 * Resolve each source file's last-modified date from git history, keyed by
 * absolute source path. Runs a single `git log` over the given content roots
 * (each filesystem source's own root, which may diverge from `content.root`)
 * and maps repo-root-relative paths back to the given absolute paths
 * (monorepo-safe via `rev-parse --show-toplevel`). Returns an empty map if git
 * is unavailable or the project isn't a repo — the feature then simply shows
 * no dates.
 */
export const gitLastModifiedTimes = (
  root: string,
  contentRoots: string[],
  sourcePaths: string[]
): Map<string, string> => {
  // Nothing to date — don't pay for a git scan (an empty pathspec list would
  // log the entire repository).
  if (sourcePaths.length === 0) {
    return new Map();
  }
  try {
    const gitRoot = execFileSync(
      // oxlint-disable-next-line sonarjs/no-os-command-from-path -- git is a required dev-tool dependency resolved from PATH
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { encoding: "utf-8", env: gitEnv() }
    ).trim();
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
        "--name-only",
        "--",
        ...contentRoots,
      ],
      { encoding: "utf-8", env: gitEnv(), maxBuffer: 256 * 1024 * 1024 }
    );
    const byRepoPath = parseGitLog(output);
    const result = new Map<string, string>();
    for (const sourcePath of sourcePaths) {
      const iso = byRepoPath.get(relative(gitRoot, sourcePath));
      if (iso) {
        result.set(sourcePath, iso);
      }
    }
    return result;
  } catch {
    return new Map();
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
      suggestion:
        "Fetch full history in CI: set the VERCEL_DEEP_CLONE=true environment variable on Vercel, or fetch-depth: 0 for actions/checkout.",
    },
  ];
};
