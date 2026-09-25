import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverContent } from "../src/core/content.ts";
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
  const root = await mkdtemp(join(tmpdir(), "blume-unloadable-"));
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

const loadVault = (root: string) =>
  obsidianSource(
    { name: "obsidian", vault: "." },
    { cacheDir: join(root, ".cache"), mode: "build", projectRoot: root }
  ).load();

// Windows allows `#` in file names but not `?`, so `?` is covered off Windows.
const onPosix = it.skipIf(process.platform === "win32");

describe("content files Astro's loader can't read", () => {
  it("reports a # in a file or folder name instead of publishing it", async () => {
    const root = await tree({
      "100%.md": "# Percent\n",
      "c#/intro.md": "# Intro\n",
      "index.md": "# Home\n",
      "sdks/c#.md": "# C sharp\n",
    });
    const { diagnostics, entries } = await loadDocs(root);
    // `%` loads fine — the loader escapes it — so only the `#` paths drop.
    expect(entries.map((entry) => entry.ref)).toStrictEqual([
      "100%.md",
      "index.md",
    ]);
    expect(diagnostics).toStrictEqual([
      {
        code: "BLUME_UNLOADABLE_FILE_NAME",
        file: join(root, "c#/intro.md"),
        message:
          '"c#/intro.md" has a "#" or "?" in its path, which Astro\'s content loader reads as the start of a URL fragment or query, so it can\'t load the file. It was left out of the site.',
        severity: "error",
        suggestion:
          'Rename the file (or its folder) without "#" or "?". Both are dropped from the page\'s URL anyway, so the page keeps its route.',
      },
      expect.objectContaining({
        code: "BLUME_UNLOADABLE_FILE_NAME",
        file: join(root, "sdks/c#.md"),
      }),
    ]);
  });

  onPosix("reports a ? in a file name", async () => {
    const root = await tree({
      "faq/why?.md": "# Why\n",
      "index.md": "# Home\n",
    });
    const { diagnostics, pages } = await discoverContent({
      contentRoot: root,
      defaultType: "doc",
      exclude: [],
      include: ["**/*.{md,mdx}"],
    });
    // No page publishes at `/faq/why` to render "Page not found".
    expect(pages.map((page) => page.route)).toStrictEqual(["/"]);
    expect(diagnostics).toMatchObject([
      {
        code: "BLUME_UNLOADABLE_FILE_NAME",
        file: join(root, "faq/why?.md"),
        severity: "error",
      },
    ]);
    expect(diagnostics[0]?.message).toContain('"faq/why?.md"');
  });

  it("reports a vault note whose staged copy Astro couldn't read", async () => {
    // A note is staged under its vault path, so the same limit applies.
    const root = await tree({
      "C#.md": "# C sharp\n",
      "Notes.md": "# Notes\n",
    });
    const { diagnostics, entries } = await loadVault(root);
    expect(entries.map((entry) => entry.ref)).toStrictEqual(["Notes.md"]);
    expect(diagnostics).toMatchObject([
      {
        code: "BLUME_UNLOADABLE_FILE_NAME",
        file: join(root, "C#.md"),
        severity: "error",
      },
    ]);
  });

  onPosix("degrades a wikilink to a note left out", async () => {
    const root = await tree({
      "Links.md": "See [[Why?]].\n",
      "Why?.md": "# Why\n",
    });
    const { diagnostics, entries } = await loadVault(root);
    expect(entries.map((entry) => entry.body.text)).toStrictEqual([
      "See Why?.",
    ]);
    expect(diagnostics).toMatchObject([
      { code: "BLUME_UNLOADABLE_FILE_NAME", severity: "error" },
      { code: "BLUME_WIKILINK_UNRESOLVED", severity: "warning" },
    ]);
  });
});
