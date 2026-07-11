import { execFileSync } from "node:child_process";

import { relative } from "pathe";

/** Normalized form of the `lastModified` config. */
export interface ResolvedLastModified {
  enabled: boolean;
  source: "git" | "frontmatter";
}

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
      { encoding: "utf-8" }
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
      { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }
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
