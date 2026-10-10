import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  datePublishedShallowWarning,
  gitFileDates,
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

const runGit = (root: string, args: string[]): string =>
  // Test fixture drives a real git repo; `git` is expected on PATH in CI/dev.
  // oxlint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    env: fixtureGitEnv(),
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/**
 * Init a fixture repository and return its root as git spells it — the
 * spelling every path git prints is compared against. Neither `realpathSync`
 * nor pathe gets there: macOS routes `/var` through `/private/var`, and
 * Windows hands the temp dir out under an 8.3 short name (`RUNNER~1` for
 * `runneradmin`) that git expands. Fixture paths derive from this root, never
 * from the one `mkdtemp` returned.
 */
const initRepo = (dir: string): string => {
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@blume.dev"]);
  runGit(dir, ["config", "user.name", "Blume Test"]);
  return runGit(dir, ["rev-parse", "--show-toplevel"]);
};

/** Stage everything and commit at a pinned date; commits run within the same second otherwise. */
const commitAt = (root: string, iso: string, message: string): void => {
  runGit(root, ["add", "-A"]);
  execFileSync(
    // oxlint-disable-next-line sonarjs/no-os-command-from-path
    "git",
    ["-C", root, "-c", "commit.gpgsign=false", "commit", "-m", message],
    {
      env: {
        ...fixtureGitEnv(),
        GIT_AUTHOR_DATE: iso,
        GIT_COMMITTER_DATE: iso,
      },
      stdio: "ignore",
    }
  );
};

describe("resolveLastModifiedConfig", () => {
  it("disables on false", () => {
    expect(resolveLastModifiedConfig(false)).toEqual({
      enabled: false,
      source: "git",
    });
  });

  it('enables the git source on "git"', () => {
    expect(resolveLastModifiedConfig("git")).toEqual({
      enabled: true,
      source: "git",
    });
  });

  it('enables the frontmatter-only source on "frontmatter"', () => {
    expect(resolveLastModifiedConfig("frontmatter")).toEqual({
      enabled: true,
      source: "frontmatter",
    });
  });
});

describe("parseGitLog", () => {
  it("maps each path to its most recent (first-seen) commit date", () => {
    // Mirrors `git log --format=%x00%cI --name-status`: a NUL-prefixed date
    // line, a blank line, then a status line per path the commit touched,
    // newest commit first.
    const output = [
      dateLine("2026-06-20T10:00:00+00:00"),
      "",
      "M\tdocs/a.mdx",
      "A\tdocs/b.mdx",
      dateLine("2026-01-01T00:00:00+00:00"),
      "",
      "A\tdocs/a.mdx",
      "A\tdocs/c.mdx",
    ].join("\n");

    const times = parseGitLog(output).modified;
    // a.mdx appears in both commits; the newer (first-seen) date wins.
    expect(times.get("docs/a.mdx")).toBe("2026-06-20T10:00:00+00:00");
    expect(times.get("docs/b.mdx")).toBe("2026-06-20T10:00:00+00:00");
    expect(times.get("docs/c.mdx")).toBe("2026-01-01T00:00:00+00:00");
  });

  it("follows an exact rename back to the commit that last changed the file", () => {
    const output = [
      dateLine("2026-09-01T00:00:00+00:00"),
      "",
      "R100\tdocs/guide.md\tdocs/guide.mdx",
      // A later file takes the old name; it's a different file.
      dateLine("2026-08-01T00:00:00+00:00"),
      "",
      "R100\tdocs/old/guide.md\tdocs/guide.md",
      dateLine("2026-03-01T00:00:00+00:00"),
      "",
      "M\tdocs/old/guide.md",
      dateLine("2026-01-01T00:00:00+00:00"),
      "",
      "A\tdocs/old/guide.md",
    ].join("\n");

    const times = parseGitLog(output).modified;
    // Two renames, neither of which changed the content: the date is the
    // edit before them, read under the file's current name.
    expect(times.get("docs/guide.mdx")).toBe("2026-03-01T00:00:00+00:00");
    expect(times.has("docs/guide.md")).toBe(false);
    expect(times.has("docs/old/guide.md")).toBe(false);
  });

  it("dates a file at its rename when the log holds nothing older", () => {
    // A shallow clone's history can end at the rename itself.
    const output = [
      dateLine("2026-09-01T00:00:00+00:00"),
      "",
      "M\tdocs/b.mdx",
      dateLine("2026-08-01T00:00:00+00:00"),
      "",
      "R100\tdocs/a.md\tdocs/a.mdx",
      "R100\tdocs/b.md\tdocs/b.mdx",
    ].join("\n");

    const times = parseGitLog(output).modified;
    expect(times.get("docs/a.mdx")).toBe("2026-08-01T00:00:00+00:00");
    // An edit after the rename still dates the file.
    expect(times.get("docs/b.mdx")).toBe("2026-09-01T00:00:00+00:00");
  });

  it("ignores blank lines and returns an empty map for empty input", () => {
    expect(parseGitLog("").modified.size).toBe(0);
    expect(parseGitLog("\n\n").modified.size).toBe(0);
  });

  it("dates publication at the add, under the file's current name", () => {
    const output = [
      dateLine("2026-09-01T00:00:00+00:00"),
      "",
      "R100\tdocs/guide.md\tdocs/guide.mdx",
      "A\tdocs/new.md",
      "D\tdocs/old.md",
      "R100\tdocs/cut.md\tdocs/cut.mdx",
      dateLine("2026-05-01T00:00:00+00:00"),
      "",
      "A\tdocs/page.md",
      dateLine("2026-03-01T00:00:00+00:00"),
      "",
      "M\tdocs/guide.md",
      "A\tdocs/old.md",
      "D\tdocs/page.md",
      dateLine("2026-01-01T00:00:00+00:00"),
      "",
      "A\tdocs/guide.md",
      "A\tdocs/page.md",
    ].join("\n");

    const { published } = parseGitLog(output);
    // Renamed without edits: still the commit that first added it.
    expect(published.get("docs/guide.mdx")).toBe("2026-01-01T00:00:00+00:00");
    expect(published.get("docs/new.md")).toBe("2026-09-01T00:00:00+00:00");
    // Deleted and added again: the older file at that path isn't this one.
    expect(published.get("docs/page.md")).toBe("2026-05-01T00:00:00+00:00");
    // A history that starts at a rename (a shallow clone) dates from it.
    expect(published.get("docs/cut.mdx")).toBe("2026-09-01T00:00:00+00:00");
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
      "blume.config.ts": 'export default { lastModified: "frontmatter" };\n',
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
    const root = initRepo(
      await makeProject({
        "blume.config.ts": [
          "export default {",
          '  content: { sources: [{ kind: "filesystem", options: { root: "documentation" }, requiredSecrets: [], runtimeDeps: [] }] },',
          '  lastModified: "git",',
          "};",
          "",
        ].join("\n"),
        "documentation/index.md": "# Home\n",
      })
    );
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
    const root = initRepo(
      await makeProject({
        "blume.config.ts": [
          "export default {",
          '  content: { sources: [{ kind: "obsidian", options: { vault: "vault" }, requiredSecrets: [], runtimeDeps: [] }] },',
          '  lastModified: "git",',
          "};",
          "",
        ].join("\n"),
        "vault/Draft.md": "# Draft\n",
        "vault/Welcome.md": "# Welcome\n",
      })
    );
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
    const root = await mkdtemp(join(tmpdir(), "blume-gitroot-"));
    dirs.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("finds the toplevel of the repository containing root", async () => {
    const root = initRepo(await makeDir());
    const nested = join(root, "docs");
    await mkdir(nested, { recursive: true });
    expect(gitRepositoryRoot(nested)).toBe(root);
  });

  it("is null outside a repository", async () => {
    const root = await makeDir();
    expect(gitRepositoryRoot(root)).toBeNull();
  });
});

describe("gitFileDates", () => {
  const dirs: string[] = [];

  // A plain temp dir; tests that need a repository init one and adopt git's
  // spelling of its root (see `initRepo`).
  const makeDir = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "blume-gitmod-"));
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
    const root = initRepo(await makeDir());
    const tracked = join(root, "note.md");
    await writeFile(tracked, "# Note\n");
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add note"]);

    expect(gitFileDates(root, [root], [tracked]).modified.get(tracked)).toMatch(
      /^\d{4}-\d{2}-\d{2}T/u
    );
    expect(gitFileDates(root, [], [tracked]).modified).toEqual(new Map());
    // A caller that already resolved the repository root hands it in; `null`
    // means it found none, and nothing is spawned for it.
    expect(
      gitFileDates(root, [root], [tracked], gitRepositoryRoot(root)).modified
    ).toEqual(gitFileDates(root, [root], [tracked]).modified);
    expect(gitFileDates(root, [root], [tracked], null).modified).toEqual(
      new Map()
    );
  });

  it("reads the most recent commit date for a tracked file", async () => {
    const root = initRepo(await makeDir());
    const contentRoot = join(root, "docs");
    const tracked = join(contentRoot, "index.md");
    await mkdir(contentRoot, { recursive: true });
    await writeFile(tracked, "# Home\n");
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add docs"]);

    const untracked = join(contentRoot, "missing.md");
    const times = gitFileDates(
      root,
      [contentRoot],
      [tracked, untracked]
    ).modified;

    expect(times.get(tracked)).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    // A path with no commit history is simply absent from the map.
    expect(times.has(untracked)).toBe(false);
  });

  it("keeps a page's date across a rename that leaves its content alone", async () => {
    const root = initRepo(await makeDir());
    const contentRoot = join(root, "docs");
    await mkdir(contentRoot, { recursive: true });
    await writeFile(join(contentRoot, "guide.md"), "# Guide\n\nSteps.\n");
    await writeFile(join(contentRoot, "faq.md"), "# FAQ\n\nAnswers.\n");
    commitAt(root, "2026-01-01T00:00:00Z", "add docs");
    // `.md` to `.mdx` as is, and `.md` to `.mdx` with an edit.
    runGit(root, ["mv", "docs/guide.md", "docs/guide.mdx"]);
    runGit(root, ["mv", "docs/faq.md", "docs/faq.mdx"]);
    await writeFile(join(contentRoot, "faq.mdx"), "# FAQ\n\nNew answers.\n");
    commitAt(root, "2026-09-01T00:00:00Z", "rename to mdx");

    const guide = join(contentRoot, "guide.mdx");
    const faq = join(contentRoot, "faq.mdx");
    const times = gitFileDates(root, [contentRoot], [guide, faq]).modified;
    expect(new Date(times.get(guide) ?? "").toISOString()).toBe(
      "2026-01-01T00:00:00.000Z"
    );
    expect(new Date(times.get(faq) ?? "").toISOString()).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });

  it("dates publication by exact renames only", async () => {
    // `git log --follow` pairs files 50% alike, so a new page added in the
    // commit that deletes a similar one would inherit the old page's date.
    const root = initRepo(await makeDir());
    const contentRoot = join(root, "docs");
    await mkdir(contentRoot, { recursive: true });
    const boilerplate =
      "# Page\n\nShared intro.\nShared setup.\nShared steps.\n";
    await writeFile(join(contentRoot, "old.md"), boilerplate);
    await writeFile(join(contentRoot, "guide.md"), "# Guide\n");
    commitAt(root, "2020-01-01T00:00:00Z", "add docs");
    await rm(join(contentRoot, "old.md"));
    await writeFile(join(contentRoot, "new.md"), `${boilerplate}New.\n`);
    runGit(root, ["mv", "docs/guide.md", "docs/guide.mdx"]);
    commitAt(root, "2024-01-01T00:00:00Z", "replace old with new");

    const created = join(contentRoot, "new.md");
    const renamed = join(contentRoot, "guide.mdx");
    const { published } = gitFileDates(root, [contentRoot], [created, renamed]);
    expect(new Date(published.get(created) ?? "").toISOString()).toBe(
      "2024-01-01T00:00:00.000Z"
    );
    expect(new Date(published.get(renamed) ?? "").toISOString()).toBe(
      "2020-01-01T00:00:00.000Z"
    );
  });

  it("ignores a GIT_DIR inherited from a parent git process", async () => {
    // Git hooks (husky pre-commit, post-merge) run with GIT_DIR exported; an
    // inherited absolute GIT_DIR overrides `-C` discovery, so without the env
    // sanitizing every call would read the parent's repository instead.
    const root = initRepo(await makeDir());
    const contentRoot = join(root, "docs");
    const tracked = join(contentRoot, "index.md");
    await mkdir(contentRoot, { recursive: true });
    await writeFile(tracked, "# Home\n");
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add docs"]);

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "elsewhere", ".git");
    try {
      const times = gitFileDates(root, [contentRoot], [tracked]).modified;
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
    const root = initRepo(await makeDir());
    const tracked = join(root, "note.md");
    await writeFile(tracked, "# Note\n");
    runGit(root, ["add", "-A"]);
    runGit(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add note"]);

    const outside = await makeDir();
    const times = gitFileDates(
      root,
      [join(outside, "vault")],
      [tracked]
    ).modified;
    expect(times.size).toBe(0);
  });

  it("returns an empty map outside a git repository", async () => {
    const root = await makeDir();
    const times = gitFileDates(
      root,
      [join(root, "docs")],
      [join(root, "docs", "index.md")]
    ).modified;
    expect(times.size).toBe(0);
  });

  it("skips the git scan entirely when there is nothing to date", async () => {
    // An empty pathspec list would otherwise log the whole repository.
    const root = await makeDir();
    expect(gitFileDates(root, [], []).modified.size).toBe(0);
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

  it("dates no page's publication in a shallow clone, and says so", async () => {
    const full = await makeRepoDir();
    await mkdir(join(full, "docs"), { recursive: true });
    await writeFile(
      join(full, "blume.config.ts"),
      'export default { seo: { datePublished: "git" } };\n'
    );
    await writeFile(join(full, "docs/index.md"), "# Home\n");
    await writeFile(
      join(full, "docs/post.md"),
      "---\ndate: 2019-05-01\n---\n# Post\n"
    );
    initRepo(full);
    commitAt(full, "2020-01-02T00:00:00Z", "one");
    await writeFile(join(full, "docs/index.md"), "# Home\n\nEdited.\n");
    commitAt(full, "2021-01-02T00:00:00Z", "two");

    const deep = await scanProject(full);
    const published = (project: typeof deep, path: string) =>
      project.manifest.routes.find((route) => route.path === path)?.published;
    // Git dates the page that has no date of its own; front matter wins.
    expect(new Date(published(deep, "/") ?? "").toISOString()).toBe(
      "2020-01-02T00:00:00.000Z"
    );
    expect(published(deep, "/post")).toBeUndefined();
    expect(
      deep.diagnostics.some((d) => d.code === "BLUME_SHALLOW_GIT_HISTORY")
    ).toBe(false);

    const shallow = join(await makeRepoDir(), "clone");
    runGit(dirname(shallow), [
      "clone",
      "--depth",
      "1",
      `file://${full}`,
      shallow,
    ]);
    const cut = await scanProject(shallow);
    expect(published(cut, "/")).toBeUndefined();
    const warning = cut.diagnostics.find(
      (d) => d.code === "BLUME_SHALLOW_GIT_HISTORY"
    );
    expect(warning?.message).toContain("datePublished");
    expect(warning?.message).toContain("1 page(s)");
    expect(datePublishedShallowWarning(0)).toHaveLength(0);
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
