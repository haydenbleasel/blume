import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { scanProject } from "../src/core/project-graph.ts";
import { filesystemSource } from "../src/core/sources/filesystem.ts";
import { obsidianSource } from "../src/core/sources/obsidian.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A temp directory holding `files` (relative path → content). */
const tree = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-yaml-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, text]) => {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    })
  );
  return root;
};

const loadDocs = (root: string) =>
  filesystemSource({
    exclude: [],
    include: ["**/*.{md,mdx}"],
    name: "filesystem",
    projectRoot: root,
    root,
  }).load();

// An unquoted `: ` inside a value reads as a nested mapping, which js-yaml
// rejects at the second colon: line 3, column 19 of the file.
const UNQUOTED_COLON =
  "---\ntitle: Setup\ndescription: Setup: the easy way\n---\n\n# Setup\n";

describe("front matter that isn't valid YAML", () => {
  it("leaves the file out and reports it at the offending line", async () => {
    const root = await tree({
      "index.md": "# Home\n",
      "setup.md": UNQUOTED_COLON,
    });
    const { diagnostics, entries } = await loadDocs(root);
    expect(entries.map((entry) => entry.ref)).toStrictEqual(["index.md"]);
    expect(diagnostics).toStrictEqual([
      {
        code: "BLUME_FRONTMATTER_INVALID",
        column: 19,
        file: join(root, "setup.md"),
        line: 3,
        message:
          "Front matter isn't valid YAML (bad indentation of a mapping entry), so the page was left out of the site.",
        severity: "error",
        suggestion:
          'Wrap the value at that line in double quotes, e.g. description: "Setup: the easy way".',
      },
    ]);
  });

  it("still throws a front matter failure that isn't YAML's", async () => {
    // gray-matter has no TOML engine; that's not a malformed page.
    const root = await tree({ "index.md": '---toml\ntitle = "Home"\n---\n' });
    await expect(loadDocs(root)).rejects.toThrow("toml");
  });

  it("reports a vault note the same way", async () => {
    const root = await tree({
      "Notes.md": "# Notes\n",
      "Setup.md": UNQUOTED_COLON,
    });
    const { diagnostics, entries } = await obsidianSource(
      { name: "obsidian", vault: "." },
      { cacheDir: join(root, ".cache"), mode: "build", projectRoot: root }
    ).load();
    expect(entries.map((entry) => entry.ref)).toStrictEqual(["Notes.md"]);
    expect(diagnostics).toMatchObject([
      {
        code: "BLUME_FRONTMATTER_INVALID",
        file: join(root, "Setup.md"),
        line: 3,
      },
    ]);
  });

  it("reaches the scan's diagnostics instead of failing the command", async () => {
    // `blume validate`, `doctor`, `audit`, `build`, and `dev` all start here;
    // the thrown YAMLException used to surface as BLUME_INTERNAL.
    const root = await tree({
      "docs/index.md": "# Home\n",
      "docs/setup.md": UNQUOTED_COLON,
    });
    const project = await scanProject(root, { mode: "build" });
    expect(project.graph.pages.map((page) => page.route)).toStrictEqual(["/"]);
    expect(project.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BLUME_FRONTMATTER_INVALID",
        file: join(root, "docs/setup.md"),
        line: 3,
      })
    );
  });
});
