import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  gitLastModifiedTimes,
  parseGitLog,
  resolveLastModifiedConfig,
} from "../src/core/last-modified.ts";
import { scanProject } from "../src/core/project-graph.ts";

// The byte `git log --format=%x00…` prefixes each date line with.
const nul = String.fromCodePoint(0);
const dateLine = (iso: string): string => `${nul}${iso}`;

const runGit = (root: string, args: string[]): void => {
  // Test fixture drives a real git repo; `git` is expected on PATH in CI/dev.
  // oxlint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
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
