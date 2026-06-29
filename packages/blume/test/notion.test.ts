import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { notionSource } from "../src/core/sources/notion.ts";
import type { NotionClientLike } from "../src/core/sources/notion.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import type { SourceContext } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-notion-"));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
});

const rich = (plain_text: string, annotations?: Record<string, boolean>) => ({
  annotations,
  plain_text,
});

const PAGE = {
  id: "page1",
  last_edited_time: "2024-05-01T00:00:00Z",
  properties: {
    Description: { rich_text: [rich("A short intro")], type: "rich_text" },
    Name: { title: [rich("Hello World")], type: "title" },
    Order: { number: 2, type: "number" },
    Status: { status: { name: "Published" }, type: "status" },
  },
};

const BLOCKS: Record<string, unknown[]> = {
  callout1: [
    {
      id: "c-p",
      paragraph: { rich_text: [rich("be careful")] },
      type: "paragraph",
    },
  ],
  col1: [
    { id: "l-p", paragraph: { rich_text: [rich("left")] }, type: "paragraph" },
  ],
  col2: [
    { id: "r-p", paragraph: { rich_text: [rich("right")] }, type: "paragraph" },
  ],
  collist1: [
    { has_children: true, id: "col1", type: "column" },
    { has_children: true, id: "col2", type: "column" },
  ],
  page1: [
    { heading_2: { rich_text: [rich("Title")] }, id: "h1", type: "heading_2" },
    {
      id: "p1",
      paragraph: { rich_text: [rich("Body "), rich("bold", { bold: true })] },
      type: "paragraph",
    },
    {
      callout: { rich_text: [rich("Note")] },
      has_children: true,
      id: "callout1",
      type: "callout",
    },
    {
      has_children: true,
      id: "toggle1",
      toggle: { rich_text: [rich("More")] },
      type: "toggle",
    },
    {
      column_list: {},
      has_children: true,
      id: "collist1",
      type: "column_list",
    },
    {
      code: { language: "ts", rich_text: [rich("const x = 1")] },
      id: "code1",
      type: "code",
    },
    {
      id: "img1",
      image: {
        caption: [rich("Pic")],
        file: { url: "https://notion.so/signed/pic.png" },
      },
      type: "image",
    },
  ],
  toggle1: [
    {
      id: "t-p",
      paragraph: { rich_text: [rich("hidden")] },
      type: "paragraph",
    },
  ],
};

const client = (): NotionClientLike =>
  ({
    blocks: {
      children: {
        list: ({ block_id }: { block_id: string }) =>
          Promise.resolve({
            has_more: false,
            next_cursor: null,
            results: BLOCKS[block_id] ?? [],
          }),
      },
    },
    databases: {
      query: () =>
        Promise.resolve({
          has_more: false,
          next_cursor: null,
          results: [PAGE],
        }),
    },
  }) as unknown as NotionClientLike;

const fetchImpl = (() =>
  Promise.resolve({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    ok: true,
  })) as unknown as typeof fetch;

const ctxFor = async (): Promise<SourceContext> => {
  const dir = await tempDir();
  return {
    assetsBaseUrl: "/blume-assets/handbook",
    assetsDir: join(dir, "assets"),
    cacheDir: join(dir, "cache"),
    mode: "build",
    projectRoot: dir,
  };
};

describe("notionSource", () => {
  it("maps a database page to a staged MDX entry with frontmatter", async () => {
    const source = notionSource(
      { client: client(), database: "db1", fetchImpl, name: "handbook" },
      await ctxFor()
    );
    const { entries } = await source.load();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.ref).toBe("hello-world.mdx");
    expect(entry?.data).toStrictEqual({
      description: "A short intro",
      sidebar: { order: 2 },
      title: "Hello World",
    });
    expect(entry?.lastModified).toBe("2024-05-01T00:00:00Z");
  });

  it("converts blocks to MDX with Blume components", async () => {
    const source = notionSource(
      { client: client(), database: "db1", fetchImpl, name: "handbook" },
      await ctxFor()
    );
    const { entries } = await source.load();
    const body = entries[0]?.body.text ?? "";
    expect(body).toContain("## Title");
    expect(body).toContain("Body **bold**");
    expect(body).toContain("<Callout>");
    expect(body).toContain("be careful");
    expect(body).toContain('<AccordionItem title="More">');
    expect(body).toContain("hidden");
    expect(body).toContain("<Columns>");
    expect(body).toContain("<Column>");
    expect(body).toContain("left");
    expect(body).toContain("right");
    expect(body).toContain("```ts");
  });

  it("materializes images to the public asset path", async () => {
    const source = notionSource(
      { client: client(), database: "db1", fetchImpl, name: "handbook" },
      await ctxFor()
    );
    const { entries } = await source.load();
    const body = entries[0]?.body.text ?? "";
    expect(body).toContain("![Pic](/blume-assets/handbook/");
    expect(body).not.toContain("notion.so/signed");
  });

  it("maps a non-published status to draft", async () => {
    const draftClient = {
      ...client(),
      databases: {
        query: () =>
          Promise.resolve({
            has_more: false,
            next_cursor: null,
            results: [
              {
                ...PAGE,
                properties: {
                  ...PAGE.properties,
                  Status: { status: { name: "Draft" }, type: "status" },
                },
              },
            ],
          }),
      },
    } as unknown as NotionClientLike;
    const source = notionSource(
      {
        client: draftClient,
        database: "db1",
        fetchImpl,
        name: "handbook",
        publishedValue: "Published",
      },
      await ctxFor()
    );
    const { entries } = await source.load();
    expect(entries[0]?.data.draft).toBe(true);
  });

  it("imports every page as published when publishedValue is unset", async () => {
    const source = notionSource(
      { client: client(), database: "db1", fetchImpl, name: "handbook" },
      await ctxFor()
    );
    const { entries } = await source.load();
    // Status is "Published" in the fixture, but without publishedValue the
    // adapter never infers draft — nothing is filtered.
    expect(entries[0]?.data.draft).toBeUndefined();
  });
});

describe("resolveSources (notion)", () => {
  it("wires a notion config into a staged source", () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [{ database: "db1", prefix: "handbook", type: "notion" }],
      },
    });
    const context = {
      outDir: "/p/.blume",
      root: "/p",
    } as ProjectContext;
    const sources = resolveSources(config, context, { mode: "build" });
    expect(sources[0]?.name).toBe("handbook");
    expect(sources[0]?.staged).toBe(true);
  });
});
