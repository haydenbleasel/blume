import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { buildLlmsFiles } from "../src/ai/llms.ts";
import { buildRawMarkdown } from "../src/ai/markdown.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { PageRecord } from "../src/core/types.ts";

let root: string;
const sources = new Map<string, string>();

const makePage = (
  id: string,
  route: string,
  title: string,
  over: Partial<PageRecord> = {}
): PageRecord => ({
  contentType: "doc",
  format: "md",
  groups: [],
  headings: [],
  id,
  links: [],
  meta: pageMetaSchema.parse({}),
  route,
  segments: [],
  sourcePath: join(root, id),
  title,
  ...over,
});

const makeProject = (pages: PageRecord[]): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://example.com/" },
      description: "Desc",
      title: "Docs",
    }),
    context: { configFile: null, root },
    graph: { pages },
    manifest: {
      routes: pages.map((page) => ({
        path: page.route,
        sourcePath: page.sourcePath,
      })),
    },
  }) as unknown as BlumeProject;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-ai-"));
  const files: Record<string, string> = {
    "a.md": "---\ntitle: Alpha\n---\n# Alpha\n\nBody A.\n",
    "b.md": "---\ntitle: Beta\n---\n# Beta\n\nBody B.\n",
    "c.md": "---\ntitle: Gamma\n---\n# Gamma\n\nDraft body.\n",
  };
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      sources.set(rel, content);
      await writeFile(join(root, rel), content);
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const project = (): BlumeProject =>
  makeProject([
    makePage("b.md", "/b", "Beta"),
    makePage("a.md", "/a", "Alpha", { description: "First" }),
    makePage("c.md", "/c", "Gamma", {
      meta: pageMetaSchema.parse({ draft: true }),
    }),
  ]);

describe("buildLlmsFiles — index", () => {
  it("lists non-draft pages in route order with absolute links", async () => {
    const { index } = await buildLlmsFiles(project());
    expect(index).toContain("# Docs");
    expect(index).toContain("> Desc");
    const links = index.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toStrictEqual([
      "- [Alpha](https://example.com/a.md): First",
      "- [Beta](https://example.com/b.md)",
    ]);
    expect(index).not.toContain("Gamma");
  });
});

describe("buildLlmsFiles — full", () => {
  it("emits each page body with its source URL, excluding drafts", async () => {
    const { full } = await buildLlmsFiles(project());
    expect(full).toContain("Source: https://example.com/a");
    expect(full).toContain("Body A.");
    expect(full).toContain("Body B.");
    // The section separator joins page bodies.
    expect(full).toContain("\n---\n");
    expect(full).not.toContain("Draft body.");
  });
});

describe("buildRawMarkdown", () => {
  it("maps every route to its raw (frontmatter-included) source", async () => {
    const raw = await buildRawMarkdown(project());
    expect(raw["/a"]).toBe(sources.get("a.md") ?? "");
    expect(raw["/b"]).toBe(sources.get("b.md") ?? "");
    expect(raw["/a"]).toContain("title: Alpha");
  });
});
