import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverContent } from "../src/core/content.ts";
import { discoverFolderMeta } from "../src/core/meta.ts";
import type { Diagnostic, PageRecord } from "../src/core/types.ts";

const FILES: Record<string, string> = {
  "(marketing)/about.md": "Just some text with no heading.\n",
  "01-intro.mdx":
    "---\ntitle: Intro\ndescription: Getting started\n---\n# Intro\n",
  "_meta.json": '{ "title": "Documentation", "order": 1 }',
  "aliased.md": "---\nslug: custom/path\ntitle: Aliased\n---\n# Aliased\n",
  "bad.md": "---\ndraft: maybe\n---\n# Bad\n",
  "broken/_meta.json": "{ this is not valid json",
  "guide/02-setup.md": "---\ntype: blog\ntitle: Setup\n---\n# Setup\n",
  "guide/_meta.yaml": "title: Guides\ncollapsed: true\n",
  "guide/index.md": "---\ntitle: Guide\n---\n# Guide\n",
  "index.md": "# Welcome\n\nSee the [guide](/guide).\n",
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-content-"));
  await Promise.all(
    Object.entries(FILES).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("discoverContent", () => {
  let pages: PageRecord[];
  let diagnostics: Diagnostic[];
  let byRoute: Map<string, PageRecord>;

  beforeAll(async () => {
    const result = await discoverContent({
      contentRoot: root,
      defaultType: "doc",
      exclude: ["**/_*", "**/.*"],
      include: ["**/*.{md,mdx}"],
    });
    ({ pages } = result);
    ({ diagnostics } = result);
    byRoute = new Map(pages.map((page) => [page.route, page]));
  });

  it("maps file paths to routes, dropping index and numeric prefixes", () => {
    expect([...byRoute.keys()].toSorted()).toStrictEqual([
      "/",
      "/about",
      "/custom/path",
      "/guide",
      "/guide/setup",
      "/intro",
    ]);
  });

  it("records the file format from the extension", () => {
    expect(byRoute.get("/intro")?.format).toBe("mdx");
    expect(byRoute.get("/")?.format).toBe("md");
  });

  it("derives the title from frontmatter, the first heading, then the filename", () => {
    expect(byRoute.get("/intro")?.title).toBe("Intro");
    expect(byRoute.get("/")?.title).toBe("Welcome");
    expect(byRoute.get("/about")?.title).toBe("About");
  });

  it("honors a slug override and a (group) folder", () => {
    expect(byRoute.get("/custom/path")?.segments).toStrictEqual([
      "custom",
      "path",
    ]);
    expect(byRoute.get("/about")?.groups).toStrictEqual(["marketing"]);
  });

  it("carries the content type from frontmatter", () => {
    expect(byRoute.get("/guide/setup")?.contentType).toBe("blog");
    expect(byRoute.get("/")?.contentType).toBe("doc");
  });

  it("extracts heading and link metadata", () => {
    const home = byRoute.get("/");
    expect(home?.headings.map((h) => h.text)).toStrictEqual(["Welcome"]);
    expect(home?.links.map((l) => l.target)).toStrictEqual(["/guide"]);
  });

  it("skips a page with invalid frontmatter and reports a diagnostic", () => {
    expect(byRoute.has("/bad")).toBe(false);
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("BLUME_FRONTMATTER_INVALID");
  });
});

describe("discoverFolderMeta", () => {
  it("loads JSON and YAML meta keyed by directory, reporting parse errors", async () => {
    const { meta, diagnostics } = await discoverFolderMeta(root);

    expect(meta.get("")).toStrictEqual({ order: 1, title: "Documentation" });
    expect(meta.get("guide")).toStrictEqual({
      collapsed: true,
      title: "Guides",
    });
    expect(diagnostics.map((d) => d.code)).toContain("BLUME_META_PARSE_ERROR");
  });
});
