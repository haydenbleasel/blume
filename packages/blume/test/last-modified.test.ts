import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  gitLastModifiedTimes,
  gitRepositoryRoot,
  isShallowGitRepository,
  lastModifiedShallowWarning,
  parseGitLog,
  resolveLastModifiedConfig,
} from "../src/core/last-modified.ts";
import { scanProject } from "../src/core/project-graph.ts";

// The byte `git log --format=%x00…` prefixes each date line with.
const nul = String.fromCodePoint(0);
const dateLine = (iso: string): string => `${nul}${iso}`;

/**
 * Env for fixture git commands, with the repo-locating GIT_* variables a parent
 * git process exports to its hooks stripped out. Under the pre-commit hook in a
 * linked worktree, git exports an absolute GIT_DIR, which overrides `-C`
 * discovery — without this, the fixture's `add -A`/`commit` run against the
 * real repository's branch instead of the temp repo.
 */
const GIT_LOCATION_VARS = new Set([
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
]);

const fixtureGitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !GIT_LOCATION_VARS.has(key))
  );

const runGit = (root: string, args: string[]): void => {
  // Test fixture drives a real git repo; `git` is expected on PATH in CI/dev.
  // oxlint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync("git", ["-C", root, ...args], {
    env: fixtureGitEnv(),
    stdio: "ignore",
  });
};

const initRepo = (root: string): void => {
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "test@blume.dev"]);
  runGit(root, ["config", "user.name", "Blume Test"]);
};

describe("resolveLastModifiedConfig", () => {
  it("disables on false", () => {
    expect(resolveLastModifiedConfig(false)).toEqual({
      enabled: false,
      source: "git",
    });
  });

  it("enables git on true", () => {
    expect(resolveLastModifiedConfig(true)).toEqual({
      enabled: true,
      source: "git",
    });
  });

  it("honors an explicit source", () => {
    expect(resolveLastModifiedConfig({ type: "frontmatter" })).toEqual({
      enabled: true,
      source: "frontmatter",
    });
  });
});

describe("parseGitLog", () => {
  it("maps each path to its most recent (first-seen) commit date", () => {
    // Mirrors `git log --format=%x00%cI --name-only`: a NUL-prefixed date line,
    // a blank line, then the paths the commit touched, newest commit first.
    const output = [
      dateLine("2026-06-20T10:00:00+00:00"),
      "",
      "docs/a.mdx",
      "docs/b.mdx",
      dateLine("2026-01-01T00:00:00+00:00"),
      "",
      "docs/a.mdx",
      "docs/c.mdx",
    ].join("\n");

    const times = parseGitLog(output);
    // a.mdx appears in both commits; the newer (first-seen) date wins.
    expect(times.get("docs/a.mdx")).toBe("2026-06-20T10:00:00+00:00");
    expect(times.get("docs/b.mdx")).toBe("2026-06-20T10:00:00+00:00");
    expect(times.get("docs/c.mdx")).toBe("2026-01-01T00:00:00+00:00");
  });

  it("ignores blank lines and returns an empty map for empty input", () => {
    expect(parseGitLog("").size).toBe(0);
    expect(parseGitLog("\n\n").size).toBe(0);
  });
});

describe("scanProject lastModified", () => {
  const dirs: string[] = [];

  const makeProject = async (
    files: Record<string, string>
  ): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "blume-lastmod-"));
    dirs.push(root);
    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        const abs = join(root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      })
    );
    return root;
  };

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("does not set lastModified when the feature is off", async () => {
    const root = await makeProject({ "docs/index.md": "# Home\n" });
    const project = await scanProject(root);
    expect(project.manifest.routes[0]?.lastModified).toBeUndefined();
  });

  it("uses the frontmatter date as an override, no git needed", async () => {
    const root = await makeProject({
      "blume.config.ts":
        'export default { lastModified: { type: "frontmatter" } };\n',
      "docs/index.md":
        "---\ntitle: Home\nlastModified: 2020-01-02\n---\n# Home\n",
    });
    const project = await scanProject(root);
    expect(project.manifest.routes[0]?.lastModified).toBe(
      "2020-01-02T00:00:00.000Z"
    );
  });

  it("dates pages from a filesystem source with a non-default root", async () => {
    // The git pathspec must follow the source's own root ("documentation");
    // pointing it at the default `content.root` ("docs") silently dated
    // nothing — `git log -- docs` exits 0 with empty output.
    const root = realpathSync(
      await makeProject({
        "blume.config.ts": [
          "export default {",
          '  content: { sources: [{ type: "filesystem", root: "documentation" }] },',
          "  lastModified: true,",
          "};",
          "",
        ].join("\n"),
        "documentation/index.md": "# Home\n",
      })
    );
    initRepo(root);
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add docs"]);

    const project = await scanProject(root);
    expect(project.manifest.routes[0]?.lastModified).toMatch(
      /^\d{4}-\d{2}-\d{2}T/u
    );
  });

  it("dates vault notes from a staged obsidian source", async () => {
    // The vault is a real on-disk tree, so its root must join the git pathspec
    // even though the source is staged — otherwise every vault page stays
    // undated no matter how deep the clone is.
    const root = realpathSync(
      await makeProject({
        "blume.config.ts": [
          "export default {",
          '  content: { sources: [{ type: "obsidian", vault: "vault" }] },',
          "  lastModified: true,",
          "};",
          "",
        ].join("\n"),
        "vault/Draft.md": "# Draft\n",
        "vault/Welcome.md": "# Welcome\n",
      })
    );
    initRepo(root);
    // `Draft.md` stays untracked: an undated page beside a dated one drives
    // the undated count down the covered-roots path.
    runGit(root, ["add", "vault/Welcome.md"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add vault"]);

    const project = await scanProject(root);
    const welcome = project.manifest.routes.find(
      (route) => route.path === "/welcome"
    );
    const draft = project.manifest.routes.find(
      (route) => route.path === "/draft"
    );
    expect(welcome?.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(draft?.lastModified).toBeUndefined();
  });
});

describe("gitRepositoryRoot", () => {
  const dirs: string[] = [];

  const makeDir = async (): Promise<string> => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "blume-gitroot-")));
    dirs.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("finds the toplevel of the repository containing root", async () => {
    const root = await makeDir();
    initRepo(root);
    const nested = join(root, "docs");
    await mkdir(nested, { recursive: true });
    expect(gitRepositoryRoot(nested)).toBe(root);
  });

  it("is null outside a repository", async () => {
    const root = await makeDir();
    expect(gitRepositoryRoot(root)).toBeNull();
  });
});

describe("gitLastModifiedTimes", () => {
  const dirs: string[] = [];

  // `realpathSync` canonicalizes the temp dir (macOS routes `/var` through
  // `/private/var`) so the paths we pass match `git rev-parse --show-toplevel`.
  const makeRepoDir = async (): Promise<string> => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "blume-gitmod-")));
    dirs.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("skips the scan when no content root bounds the pathspec", async () => {
    // An all-staged project contributes no content root, yet its entries can
    // still carry a `sourcePath`. Without the guard, `git log -- ` runs with an
    // empty pathspec and logs the entire repository — which in this fixture
    // would happily date the tracked file. An empty map proves the scan was
    // skipped, not merely that git failed.
    const root = await makeRepoDir();
    const tracked = join(root, "note.md");
    await writeFile(tracked, "# Note\n");
    initRepo(root);
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add note"]);

    expect(gitLastModifiedTimes(root, [root], [tracked]).get(tracked)).toMatch(
      /^\d{4}-\d{2}-\d{2}T/u
    );
    expect(gitLastModifiedTimes(root, [], [tracked])).toEqual(new Map());
    // A caller that already resolved the repository root hands it in; `null`
    // means it found none, and nothing is spawned for it.
    expect(
      gitLastModifiedTimes(root, [root], [tracked], gitRepositoryRoot(root))
    ).toEqual(gitLastModifiedTimes(root, [root], [tracked]));
    expect(gitLastModifiedTimes(root, [root], [tracked], null)).toEqual(
      new Map()
    );
  });

  it("reads the most recent commit date for a tracked file", async () => {
    const root = await makeRepoDir();
    const contentRoot = join(root, "docs");
    const tracked = join(contentRoot, "index.md");
    await mkdir(contentRoot, { recursive: true });
    await writeFile(tracked, "# Home\n");
    initRepo(root);
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add docs"]);

    const untracked = join(contentRoot, "missing.md");
    const times = gitLastModifiedTimes(
      root,
      [contentRoot],
      [tracked, untracked]
    );

    expect(times.get(tracked)).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    // A path with no commit history is simply absent from the map.
    expect(times.has(untracked)).toBe(false);
  });

  it("ignores a GIT_DIR inherited from a parent git process", async () => {
    // Git hooks (husky pre-commit, post-merge) run with GIT_DIR exported; an
    // inherited absolute GIT_DIR overrides `-C` discovery, so without the env
    // sanitizing every call would read the parent's repository instead.
    const root = await makeRepoDir();
    const contentRoot = join(root, "docs");
    const tracked = join(contentRoot, "index.md");
    await mkdir(contentRoot, { recursive: true });
    await writeFile(tracked, "# Home\n");
    initRepo(root);
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add docs"]);

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "elsewhere", ".git");
    try {
      const times = gitLastModifiedTimes(root, [contentRoot], [tracked]);
      expect(times.get(tracked)).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previous;
      }
    }
  });

  it("returns an empty map when the log fails on an out-of-repo root", async () => {
    // Callers filter these out, but the function still defends itself: a
    // pathspec outside the repository makes `git log` fail outright.
    const root = await makeRepoDir();
    const tracked = join(root, "note.md");
    await writeFile(tracked, "# Note\n");
    initRepo(root);
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add note"]);

    const outside = await makeRepoDir();
    const times = gitLastModifiedTimes(
      root,
      [join(outside, "vault")],
      [tracked]
    );
    expect(times.size).toBe(0);
  });

  it("returns an empty map outside a git repository", async () => {
    const root = await makeRepoDir();
    const times = gitLastModifiedTimes(
      root,
      [join(root, "docs")],
      [join(root, "docs", "index.md")]
    );
    expect(times.size).toBe(0);
  });

  it("skips the git scan entirely when there is nothing to date", async () => {
    // An empty pathspec list would otherwise log the whole repository.
    const root = await makeRepoDir();
    expect(gitLastModifiedTimes(root, [], []).size).toBe(0);
  });
});

describe("shallow clone detection", () => {
  const dirs: string[] = [];

  const makeRepoDir = async (): Promise<string> => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "blume-shallow-")));
    dirs.push(root);
    return root;
  };

  // A full fixture repo plus a `--depth 1` clone of it. The `file://` URL is
  // load-bearing: a plain-path local clone ignores `--depth` and stays full.
  const makeShallowPair = async (): Promise<{
    full: string;
    shallow: string;
  }> => {
    const full = await makeRepoDir();
    await writeFile(join(full, "index.md"), "# Home\n");
    initRepo(full);
    runGit(full, ["add", "-A"]);
    runGit(full, ["-c", "commit.gpgsign=false", "commit", "-m", "one"]);
    const shallow = join(await makeRepoDir(), "clone");
    runGit(dirname(shallow), [
      "clone",
      "--depth",
      "1",
      `file://${full}`,
      shallow,
    ]);
    return { full, shallow };
  };

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("tells shallow clones apart from full ones and non-repos", async () => {
    const { full, shallow } = await makeShallowPair();
    expect(isShallowGitRepository(shallow)).toBe(true);
    expect(isShallowGitRepository(full)).toBe(false);
    // Outside any repository the answer is false — there, no dates exist at
    // all and the shallow hint would only mislead.
    const bare = await makeRepoDir();
    expect(isShallowGitRepository(bare)).toBe(false);
  });

  it("warns about undated pages only in a shallow clone", async () => {
    const { full, shallow } = await makeShallowPair();
    const warnings = lastModifiedShallowWarning(shallow, 3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("BLUME_SHALLOW_GIT_HISTORY");
    expect(warnings[0]?.severity).toBe("warning");
    expect(warnings[0]?.message).toContain("3 page(s)");
    expect(warnings[0]?.suggestion).toContain("VERCEL_DEEP_CLONE");
    // Every page dated, or a full clone: nothing to warn about.
    expect(lastModifiedShallowWarning(shallow, 0)).toHaveLength(0);
    expect(lastModifiedShallowWarning(full, 3)).toHaveLength(0);
  });
});
