import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { gitLastModifiedTimes, realPath } from "../src/core/last-modified.ts";
import { scanProject } from "../src/core/project-graph.ts";

/**
 * The repo-locating GIT_* variables a parent git process exports to its
 * hooks; an inherited GIT_DIR would point the fixture's commands at the real
 * repository instead of the temp one.
 */
const GIT_LOCATION_VARS = new Set([
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
]);

const runGit = (root: string, args: string[]): string =>
  // Test fixture drives a real git repo; `git` is expected on PATH in CI/dev.
  // oxlint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !GIT_LOCATION_VARS.has(key))
    ),
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-lastmod-link-"));
  dirs.push(dir);
  return dir;
};

/**
 * A committed project with git-dated pages, and a path to it through a
 * directory link. The repository root is the one git spells (see
 * last-modified.test.ts's `initRepo`), and the link — a junction on Windows,
 * which needs no privileges — is what the project is opened through.
 */
const linkedProject = async (): Promise<{ link: string; repo: string }> => {
  const dir = await tempDir();
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@blume.dev"]);
  runGit(dir, ["config", "user.name", "Blume Test"]);
  const repo = runGit(dir, ["rev-parse", "--show-toplevel"]);
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(
    join(repo, "blume.config.ts"),
    'export default { lastModified: "git" };\n'
  );
  await writeFile(join(repo, "docs", "index.md"), "# Home\n");
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "add docs"]);
  const link = join(await tempDir(), "site");
  symlinkSync(repo, link, "junction");
  return { link, repo };
};

describe("git last-modified dates through a symlinked project path", () => {
  it("dates the pages of a project opened through a link", async () => {
    // git answers `rev-parse --show-toplevel` with the link resolved, so the
    // project's own spelling of its content root compared as outside the
    // repository: every root was dropped and no page got a date.
    const { link } = await linkedProject();
    const project = await scanProject(link);
    expect(project.manifest.routes[0]?.lastModified).toMatch(
      /^\d{4}-\d{2}-\d{2}T/u
    );
  });

  it("dates nothing for a project outside any repository", async () => {
    const root = await tempDir();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "blume.config.ts"),
      'export default { lastModified: "git" };\n'
    );
    await writeFile(join(root, "docs", "index.md"), "# Home\n");
    const project = await scanProject(root);
    expect(project.manifest.routes[0]?.lastModified).toBeUndefined();
  });

  it("maps linked source paths onto the log's repository paths", async () => {
    const { link } = await linkedProject();
    const page = join(link, "docs", "index.md");
    expect(
      gitLastModifiedTimes(link, [join(link, "docs")], [page]).get(page)
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describe("realPath", () => {
  it("resolves a link to the directory it names", async () => {
    const { link, repo } = await linkedProject();
    expect(realPath(link)).toBe(realPath(repo));
    expect(realPath(join(link, "docs"))).toBe(realPath(join(repo, "docs")));
  });

  it("keeps a path that doesn't exist as written", () => {
    const missing = join(tmpdir(), "blume-lastmod-link-missing", "page.md");
    expect(realPath(missing)).toBe(missing);
  });
});
