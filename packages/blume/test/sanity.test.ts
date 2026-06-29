import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { portableTextToMarkdown } from "../src/core/sources/portable-text.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import { sanitySource } from "../src/core/sources/sanity.ts";
import type { SanityClientLike } from "../src/core/sources/sanity.ts";
import type { SourceContext, SourceEntry } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-sanity-"));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
});

const ctxFor = (cacheDir: string): SourceContext => ({
  cacheDir,
  mode: "build",
  projectRoot: cacheDir,
});

const clientReturning = (docs: unknown[]): SanityClientLike => ({
  fetch: () => Promise.resolve(docs as never),
});

describe("portableTextToMarkdown", () => {
  it("renders headings, marks, links, lists, blockquotes, and images", () => {
    const md = portableTextToMarkdown(
      [
        {
          _type: "block",
          children: [{ _type: "span", text: "Title" }],
          style: "h2",
        },
        {
          _type: "block",
          children: [
            { _type: "span", marks: [], text: "a " },
            { _type: "span", marks: ["strong"], text: "bold" },
            { _type: "span", marks: [], text: " and " },
            { _type: "span", marks: ["em"], text: "em" },
            { _type: "span", marks: [], text: " and " },
            { _type: "span", marks: ["link1"], text: "link" },
          ],
          markDefs: [{ _key: "link1", _type: "link", href: "https://x.dev" }],
          style: "normal",
        },
        {
          _type: "block",
          children: [{ _type: "span", text: "quote" }],
          style: "blockquote",
        },
        {
          _type: "block",
          children: [{ _type: "span", text: "one" }],
          level: 1,
          listItem: "bullet",
          style: "normal",
        },
        {
          _type: "image",
          alt: "Logo",
          asset: { _ref: "image-abc123-200x100-png" },
        },
      ],
      {
        imageUrl: (block) => {
          const ref = (block.asset as { _ref?: string })._ref;
          return ref ? `https://cdn/${ref}` : null;
        },
      }
    );

    expect(md).toContain("## Title");
    expect(md).toContain("a **bold** and *em* and [link](https://x.dev)");
    expect(md).toContain("> quote");
    expect(md).toContain("- one");
    expect(md).toContain("![Logo](https://cdn/image-abc123-200x100-png)");
  });

  it("uses a custom serializer and notes unknown blocks", () => {
    const md = portableTextToMarkdown(
      [{ _type: "callout", text: "Heads up" }, { _type: "mystery" }],
      { serializers: { callout: (b) => `<Callout>${b.text}</Callout>` } }
    );
    expect(md).toContain("<Callout>Heads up</Callout>");
    expect(md).toContain("unsupported Portable Text block: mystery");
  });
});

describe("sanitySource", () => {
  const doc = {
    _id: "abc",
    _updatedAt: "2024-05-01T00:00:00Z",
    body: [
      {
        _type: "block",
        children: [{ _type: "span", text: "Hello" }],
        style: "h2",
      },
    ],
    description: "Intro",
    slug: { current: "getting-started" },
    title: "Getting Started",
  };

  it("maps documents to staged entries with frontmatter and a markdown body", async () => {
    const source = sanitySource(
      {
        client: clientReturning([doc]),
        dataset: "production",
        name: "guides",
        prefix: "guides",
        projectId: "p1",
        query: "*[_type == 'guide']",
      },
      ctxFor(await tempDir())
    );

    const { entries } = await source.load();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.ref).toBe("getting-started.md");
    expect(entry?.data).toStrictEqual({
      description: "Intro",
      title: "Getting Started",
    });
    expect(entry?.body.text).toContain("## Hello");
    expect(entry?.raw).toContain("title: Getting Started");
    expect(entry?.lastModified).toBe("2024-05-01T00:00:00Z");
  });

  it("builds Sanity CDN image URLs from asset refs", async () => {
    const withImage = {
      ...doc,
      body: [
        {
          _type: "image",
          asset: { _ref: "image-deadbeef-640x480-jpg" },
        },
      ],
    };
    const source = sanitySource(
      {
        client: clientReturning([withImage]),
        dataset: "production",
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries[0]?.body.text).toContain(
      "https://cdn.sanity.io/images/p1/production/deadbeef-640x480.jpg"
    );
  });

  it("serves the cached snapshot when the query fails", async () => {
    const cacheDir = await tempDir();
    const seed: SourceEntry[] = [
      {
        body: { format: "md", text: "# Cached" },
        data: { title: "Cached" },
        raw: "---\ntitle: Cached\n---\n# Cached",
        ref: "cached.md",
      },
    ];
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "entries.json"), JSON.stringify(seed));

    const failing: SanityClientLike = {
      fetch: () => Promise.reject(new Error("unauthorized")),
    };
    const source = sanitySource(
      {
        client: failing,
        dataset: "production",
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(cacheDir)
    );
    const { entries, diagnostics } = await source.load();
    expect(entries).toHaveLength(1);
    expect(diagnostics.map((d) => d.code)).toContain("BLUME_SOURCE_OFFLINE");
  });
});

describe("resolveSources (sanity)", () => {
  it("wires a sanity config into a staged source without loading", () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [
          {
            dataset: "production",
            prefix: "guides",
            projectId: "p1",
            query: "*",
            type: "sanity",
          },
        ],
      },
    });
    const context = {
      contentRoot: "/p/docs",
      outDir: "/p/.blume",
      root: "/p",
    } as ProjectContext;

    const sources = resolveSources(config, context, { mode: "build" });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.name).toBe("guides");
    expect(sources[0]?.staged).toBe(true);
    expect(sources[0]?.prefix).toBe("guides");
  });
});
