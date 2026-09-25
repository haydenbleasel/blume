import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { cutVersion, rewriteSnapshotLinks } from "../src/core/version-cut.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** Write a project (blume.config.ts + docs tree) into a fresh temp root. */
const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-version-links-"));
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

const rewrites = new Map([
  ["/", "/v2.0"],
  ["/guides/x", "/v2.0/guides/x"],
]);

describe("rewriteSnapshotLinks link forms", () => {
  it("rewrites reference-style link definitions", () => {
    const source = [
      "See [the guide][x] and [home].",
      "",
      "[x]: /guides/x",
      '[home]: /#top "Home"',
      "   [indented]: </guides/x>",
      "[tight]:/guides/x",
    ].join("\n");
    const { text, count } = rewriteSnapshotLinks(source, rewrites);
    expect(text).toBe(
      [
        "See [the guide][x] and [home].",
        "",
        "[x]: /v2.0/guides/x",
        '[home]: /v2.0#top "Home"',
        "   [indented]: </v2.0/guides/x>",
        "[tight]:/v2.0/guides/x",
      ].join("\n")
    );
    expect(count).toBe(4);
  });

  it("leaves footnotes, deeper indents, and prose after a label alone", () => {
    const source = [
      "[^note]: /guides/x is where it lives.",
      "    [code]: /guides/x",
      "Text [x]: /guides/x",
    ].join("\n");
    expect(rewriteSnapshotLinks(source, rewrites)).toStrictEqual({
      count: 0,
      text: source,
    });
  });

  it("rewrites single-quoted href and src attributes", () => {
    const { text } = rewriteSnapshotLinks(
      "<a href='/guides/x#setup'>X</a> <img src='/guides/x' />",
      rewrites
    );
    expect(text).toBe(
      "<a href='/v2.0/guides/x#setup'>X</a> <img src='/v2.0/guides/x' />"
    );
  });

  it("rewrites links that spell the base path out, keeping the base", () => {
    const { text, count } = rewriteSnapshotLinks(
      [
        "[X](/docs/guides/x) [home](/docs/) [plain](/guides/x)",
        "[x]: /docs/guides/x",
        '<a href="/docs">Home</a>',
        "[unknown](/docs/nope) [elsewhere](/docsearch)",
      ].join("\n"),
      rewrites,
      "/docs"
    );
    expect(text).toBe(
      [
        "[X](/docs/v2.0/guides/x) [home](/docs/v2.0) [plain](/v2.0/guides/x)",
        "[x]: /docs/v2.0/guides/x",
        '<a href="/docs/v2.0">Home</a>',
        "[unknown](/docs/nope) [elsewhere](/docsearch)",
      ].join("\n")
    );
    expect(count).toBe(3);
  });
});

describe("cutVersion link forms", () => {
  it("keeps every link form in the snapshot inside the snapshot", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  basePath: "/docs",
  versions: { archived: [], current: { label: "v2.0" } },
};
`,
      "docs/guides/setup.mdx": "---\ntitle: Setup\n---\n# Setup\n",
      "docs/index.mdx": [
        "---",
        "title: Home",
        "---",
        "# Home",
        "",
        "Read [setup][s], [the based link](/docs/guides/setup), and",
        "<a href='/guides/setup'>the anchor</a>.",
        "",
        "[s]: /guides/setup",
        "",
      ].join("\n"),
    });

    await cutVersion(root, "v1.0");

    const home = await readFile(join(root, "docs/v1.0/index.mdx"), "utf-8");
    expect(home).toContain("[the based link](/docs/v1.0/guides/setup)");
    expect(home).toContain("<a href='/v1.0/guides/setup'>");
    expect(home).toContain("[s]: /v1.0/guides/setup");
  });
});
