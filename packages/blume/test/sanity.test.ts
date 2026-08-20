import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { join } from "pathe";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { portableTextToMarkdown } from "../src/core/sources/portable-text.ts";
import type { PortableTextBlock } from "../src/core/sources/portable-text.ts";
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

/** A hand-built Sanity document fixture: an id plus the fields the test maps. */
interface SanityDocFixture {
  _id: string;
  _updatedAt?: string;
  body?: PortableTextBlock[];
  description?: string;
  meta?: string;
  slug?: { current: string };
  title?: string;
}

// SAFETY: `SanityClientLike.fetch` lets each caller pick its result type; the
// fixture always resolves with the document array the test supplied for it.
const clientReturning = (docs: SanityDocFixture[]): SanityClientLike => ({
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
          // SAFETY: the image fixture above declares `asset._ref` as a string.
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

  it("watch polls fresh past the dev cache and fires on a changed document", async () => {
    let calls = 0;
    const client: SanityClientLike = {
      fetch: () => {
        calls += 1;
        // SAFETY: same generic-fetch contract as `clientReturning` — the test
        // always resolves with the fixture doc it builds here.
        return Promise.resolve([
          { ...doc, title: `Getting Started v${calls}` },
        ] as never);
      },
    };
    const source = sanitySource(
      {
        client,
        dataset: "production",
        name: "guides",
        pollInterval: 0.01,
        projectId: "p1",
        query: "*[_type == 'guide']",
      },
      { ...ctxFor(await tempDir()), refresh: false }
    );
    await source.load();

    let changes = 0;
    const stop = source.watch?.(() => {
      changes += 1;
    });
    await sleep(80);
    stop?.();
    expect(changes).toBeGreaterThanOrEqual(1);
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

describe("sanitySource (field + client resolution edge cases)", () => {
  it("returns undefined for a dot path that runs through a non-object", async () => {
    const source = sanitySource(
      {
        client: clientReturning([{ _id: "x", meta: "not-an-object" }]),
        dataset: "production",
        fields: { title: "meta.title" },
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    // getPath walked into the string `meta` and bailed → no title resolved.
    expect(entries[0]?.data.title).toBeUndefined();
    expect(entries[0]?.ref).toBe("x.md");
  });

  it("keeps non-ASCII slugs as routes instead of falling back to ids", async () => {
    const source = sanitySource(
      {
        client: clientReturning([
          { _id: "doc-a", slug: { current: "こんにちは" } },
          { _id: "doc-b", slug: { current: "你好" } },
        ]),
        dataset: "production",
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    const refs = entries.map((entry) => entry.ref).toSorted();
    // The ASCII-only slugify used to collapse these to "" and route by _id;
    // Unicode slugs now survive as authored.
    expect(refs).toStrictEqual(["こんにちは.md", "你好.md"]);
  });

  it("keeps distinct refs when slugs still slugify to empty", async () => {
    const source = sanitySource(
      {
        client: clientReturning([
          { _id: "doc-a", slug: { current: "!!!" } },
          { _id: "doc-b", slug: { current: "???" } },
        ]),
        dataset: "production",
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    const refs = entries.map((entry) => entry.ref).toSorted();
    // Pure punctuation still has nothing to keep: each falls back to its
    // unique `_id`, not a shared `untitled.md`.
    expect(refs).toStrictEqual(["doc-a.md", "doc-b.md"]);
  });

  it("keeps the segments of a slashed slug", async () => {
    // A `guides/setup`-style slug is slugged per segment, keeping its `/`
    // instead of mashing into `guidessetup`.
    const source = sanitySource(
      {
        client: clientReturning([
          { _id: "doc-a", slug: { current: "Guides/Getting Started!" } },
        ]),
        dataset: "production",
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries[0]?.ref).toBe("guides/getting-started.md");
  });

  it("skips images whose asset ref is malformed", async () => {
    const source = sanitySource(
      {
        client: clientReturning([
          {
            _id: "x",
            body: [{ _type: "image", asset: { _ref: "image-broken" } }],
          },
        ]),
        dataset: "production",
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries[0]?.body.text).not.toContain("cdn.sanity.io");
  });

  it("read() serves the staged raw, then falls back to the cache for unknown refs", async () => {
    const source = sanitySource(
      {
        client: clientReturning([
          { _id: "abc", slug: { current: "getting-started" }, title: "Hi" },
        ]),
        dataset: "production",
        name: "guides",
        projectId: "p1",
        query: "*",
      },
      ctxFor(await tempDir())
    );
    await source.load();
    const raw = await source.read?.("getting-started.md");
    expect(raw).toContain("title: Hi");
    const missing = await source.read?.("nope.md");
    expect(missing).toBe("");
  });

  // Registered before the working-SDK test below so this is the first
  // `mock.module` for the specifier (a re-registered throwing factory would
  // run eagerly and fail at registration).
  it("falls back to the cache and warns offline when the SDK is missing", async () => {
    mock.module("@sanity/client", () => {
      throw new Error("Cannot find package '@sanity/client'");
    });
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
    const source = sanitySource(
      { dataset: "production", name: "guides", projectId: "p1", query: "*" },
      ctxFor(cacheDir)
    );
    const { diagnostics, entries } = await source.load();
    expect(entries).toHaveLength(1);
    expect(diagnostics.map((d) => d.code)).toContain("BLUME_SOURCE_OFFLINE");
    expect(diagnostics[0]?.message).toContain("@sanity/client");
  });

  it("constructs a Sanity client from the SDK when none is injected", async () => {
    mock.module("@sanity/client", () => ({
      createClient: () => ({
        fetch: () =>
          Promise.resolve([{ _id: "made", body: [], title: "Made" }]),
      }),
    }));
    const source = sanitySource(
      { dataset: "production", name: "guides", projectId: "p1", query: "*" },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries[0]?.data.title).toBe("Made");
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
    const context: ProjectContext = {
      componentsFile: null,
      configFile: null,
      contentRoot: "/p/docs",
      outDir: "/p/.blume",
      pagesRoot: null,
      root: "/p",
      themeFile: null,
    };

    const sources = resolveSources(config, context, { mode: "build" });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.name).toBe("guides");
    expect(sources[0]?.staged).toBe(true);
    expect(sources[0]?.prefix).toBe("guides");
  });
});
