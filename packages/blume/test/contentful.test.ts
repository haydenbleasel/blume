import { afterAll, describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  assetFromEntry,
  contentfulRichTextToMarkdown,
} from "../src/core/sources/contentful-rich-text.ts";
import { contentfulSource } from "../src/core/sources/contentful.ts";
import type { JsonObject, JsonValue } from "../src/core/sources/json.ts";
import { asString, getPath } from "../src/core/sources/json.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import { contentful } from "../src/sources/contentful.ts";
import {
  cleanupTempDirs,
  ctxFor,
  projectContext,
  recordingFetch,
  tempDir,
  withEnv,
} from "./cms-fixtures.ts";

afterAll(cleanupTempDirs);

const text = (value: string, ...marks: string[]): JsonObject => ({
  data: {},
  marks: marks.map((type) => ({ type })),
  nodeType: "text",
  value,
});

const node = (
  nodeType: string,
  content: JsonValue[],
  data: JsonObject = {}
): JsonObject => ({ content, data, nodeType });

const paragraph = (...content: JsonValue[]): JsonObject =>
  node("paragraph", content);

const link = (id: string, linkType: string): JsonObject => ({
  target: { sys: { id, linkType, type: "Link" } },
});

const resolvedAsset: JsonObject = {
  fields: {
    description: "A chart",
    file: { url: "//images.ctfassets.net/s/chart.png" },
    title: "Chart",
  },
  sys: { id: "asset-1", type: "Asset" },
};

describe("contentfulRichTextToMarkdown", () => {
  it("renders the block, inline, and mark types the editor emits", () => {
    const md = contentfulRichTextToMarkdown(
      node("document", [
        node("heading-2", [text("Title")]),
        paragraph(
          text("plain "),
          text("bold", "bold"),
          text(" "),
          text("em", "italic"),
          text(" "),
          text("x*y", "code"),
          text(" "),
          text("old", "strikethrough"),
          text(" "),
          text("under", "underline"),
          text(" "),
          node("hyperlink", [text("site")], { uri: "https://x.dev" }),
          text(" "),
          node("entry-hyperlink", [text("entry")], link("e1", "Entry")),
          text(" "),
          node("asset-hyperlink", [text("file")], link("asset-1", "Asset")),
          text(" "),
          node("embedded-entry-inline", [], link("e1", "Entry"))
        ),
        node("unordered-list", [
          node("list-item", [
            paragraph(text("one")),
            node("ordered-list", [
              node("list-item", [paragraph(text("nested"))]),
            ]),
          ]),
          node("list-item", [paragraph(text("two"))]),
        ]),
        node("blockquote", [paragraph(text("q1")), paragraph(text("q2"))]),
        node("hr", []),
        node("embedded-asset-block", [], link("asset-1", "Asset")),
        node("embedded-asset-block", [], link("nope", "Asset")),
        node("embedded-entry-block", [], link("e1", "Entry")),
        node("embedded-entry-block", [], link("e2", "Entry")),
        node("embedded-entry-block", [], link("missing", "Entry")),
        node("table", [
          node("table-row", [
            node("table-header-cell", [paragraph(text("a|b"))]),
            node("table-header-cell", [paragraph(text("line\nbreak"))]),
          ]),
          node("table-row", [
            node("table-cell", [paragraph(text("1")), paragraph(text("1b"))]),
            node("table-cell", [paragraph(text("2"))]),
          ]),
        ]),
        node("table", []),
        node("mystery", []),
      ]),
      {
        resolveAsset: (id) =>
          id === "asset-1" ? assetFromEntry(resolvedAsset) : null,
        resolveEntry: (id) =>
          id === "missing"
            ? null
            : {
                fields: { label: `Entry ${id}` },
                sys: {
                  contentType: {
                    sys: { id: id === "e1" ? "callout" : "widget" },
                  },
                  id,
                },
              },
        serializers: {
          callout: (entry) =>
            `<Callout>${asString(getPath(entry, "fields.label")) ?? ""}</Callout>`,
        },
      }
    );
    expect(md).toBe(`## Title

plain **bold** *em* \`x*y\` ~~old~~ under [site](https://x.dev) entry [file](https://images.ctfassets.net/s/chart.png) <Callout>Entry e1</Callout>

- one
  1. nested
- two

> q1
>
> q2

---

![Chart](https://images.ctfassets.net/s/chart.png)

<Callout>Entry e1</Callout>

<!-- unsupported Contentful embedded entry: widget -->

<!-- unsupported Contentful embedded entry -->

| a\\|b | line break |
| --- | --- |
| 1 1b | 2 |

<!-- unsupported Contentful node: mystery -->
`);
  });

  it("lowers a document the SDK already resolved", () => {
    const md = contentfulRichTextToMarkdown(
      node("document", [
        node("embedded-asset-block", [], { target: resolvedAsset }),
        node("embedded-asset-block", [], {
          target: { fields: { title: "No file" }, sys: { id: "a2" } },
        }),
        node("embedded-entry-block", [], {
          target: {
            fields: { label: "Inline" },
            sys: { contentType: { sys: { id: "callout" } }, id: "e9" },
          },
        }),
        node("heading-1", [text("H1")]),
        node("heading-6", [text("H6")]),
        paragraph({ nodeType: "text" }),
      ]),
      {
        serializers: {
          callout: (entry) =>
            `<Callout>${asString(getPath(entry, "fields.label")) ?? ""}</Callout>`,
        },
      }
    );
    expect(md).toBe(`![Chart](https://images.ctfassets.net/s/chart.png)

<Callout>Inline</Callout>

# H1

###### H6
`);
  });

  it("keeps the asset description as alt when there is no title", () => {
    expect(
      assetFromEntry({
        fields: { description: "Desc", file: { url: "/f.png" } },
      })
    ).toStrictEqual({ description: "Desc", title: undefined, url: "/f.png" });
    expect(assetFromEntry({ fields: {} })).toBeNull();
    expect(
      contentfulRichTextToMarkdown(
        node("document", [
          node("embedded-asset-block", [], {
            target: {
              fields: { description: "Desc", file: { url: "/f.png" } },
            },
          }),
        ])
      )
    ).toBe("![Desc](/f.png)\n");
  });
});

const entry = (
  id: string,
  fields: JsonObject,
  updatedAt = "2026-02-01T00:00:00Z"
): JsonObject => ({
  fields,
  sys: { contentType: { sys: { id: "doc" } }, id, updatedAt },
});

describe("contentfulSource", () => {
  it("pages through the Delivery API and lowers each entry", async () => {
    const richText = node("document", [
      paragraph(text("Hello")),
      node("embedded-asset-block", [], link("asset-1", "Asset")),
      node("embedded-entry-block", [], link("note-1", "Entry")),
    ]);
    const note: JsonObject = {
      fields: { label: "Careful" },
      sys: { contentType: { sys: { id: "callout" } }, id: "note-1" },
    };
    const { calls, fetchImpl } = recordingFetch(({ url }): JsonValue => {
      const skip = Number(url.searchParams.get("skip"));
      if (skip === 0) {
        return {
          includes: { Asset: [resolvedAsset], Entry: [note] },
          items: [
            entry("a", {
              body: richText,
              description: "Intro",
              slug: "getting-started",
              title: "Getting Started",
            }),
            entry("b", { body: "# Markdown\n", slug: "md", title: "MD" }),
          ],
          total: 3,
        };
      }
      return {
        items: [entry("c", { body: 42, title: "No slug" }), { fields: {} }],
        total: 3,
      };
    });
    const source = contentfulSource(
      {
        contentType: "doc",
        fetchImpl,
        locale: "en-US",
        name: "guides",
        params: { "fields.section": "sdk" },
        prefix: "guides",
        serializers: {
          callout: (linked) =>
            `<Callout>${asString(getPath(linked, "fields.label")) ?? ""}</Callout>`,
        },
        space: "s1",
        token: "delivery",
      },
      ctxFor(await tempDir("contentful"))
    );

    const { entries } = await source.load();
    expect(entries.map((e) => e.ref)).toStrictEqual([
      "getting-started.md",
      "md.md",
      "c.md",
      "untitled.md",
    ]);
    expect(entries[0]?.data).toStrictEqual({
      description: "Intro",
      title: "Getting Started",
    });
    expect(entries[0]?.body.text).toBe(
      "Hello\n\n![Chart](https://images.ctfassets.net/s/chart.png)\n\n<Callout>Careful</Callout>\n"
    );
    expect(entries[0]?.lastModified).toBe("2026-02-01T00:00:00Z");
    expect(entries[1]?.body.text).toBe("# Markdown\n");
    expect(entries[2]?.body.text).toBe("");

    expect(calls).toHaveLength(2);
    const first = calls[0]?.url;
    expect(first?.origin).toBe("https://cdn.contentful.com");
    expect(first?.pathname).toBe("/spaces/s1/environments/master/entries");
    expect(Object.fromEntries(first?.searchParams ?? [])).toStrictEqual({
      content_type: "doc",
      "fields.section": "sdk",
      include: "2",
      limit: "100",
      locale: "en-US",
      skip: "0",
    });
    expect(calls[1]?.url.searchParams.get("skip")).toBe("2");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer delivery");
  });

  it("reads drafts through the Preview API under --preview", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({
      items: [],
      total: 0,
    }));
    const source = contentfulSource(
      {
        contentType: "doc",
        environment: "staging",
        fetchImpl,
        name: "guides",
        previewToken: "preview",
        space: "s1",
        token: "delivery",
      },
      ctxFor(await tempDir("contentful-preview"), { preview: true })
    );
    await source.load();
    expect(calls[0]?.url.origin).toBe("https://preview.contentful.com");
    expect(calls[0]?.url.pathname).toBe(
      "/spaces/s1/environments/staging/entries"
    );
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer preview");
  });

  it("falls back to the env tokens, then to no auth header", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({
      items: [],
      total: 0,
    }));
    const options = { contentType: "doc", fetchImpl, name: "g", space: "s1" };
    await withEnv("CONTENTFUL_ACCESS_TOKEN", "env-delivery", async () => {
      await withEnv("CONTENTFUL_PREVIEW_TOKEN", "env-preview", async () => {
        await contentfulSource(
          options,
          ctxFor(await tempDir("contentful-env"), { preview: true })
        ).load();
        await contentfulSource(
          options,
          ctxFor(await tempDir("contentful-env"))
        ).load();
      });
      await contentfulSource(
        options,
        ctxFor(await tempDir("contentful-env"), { preview: true })
      ).load();
    });
    await withEnv("CONTENTFUL_ACCESS_TOKEN", undefined, async () => {
      await contentfulSource(
        options,
        ctxFor(await tempDir("contentful-env"))
      ).load();
    });
    expect(
      calls.map((call) => call.headers.get("authorization"))
    ).toStrictEqual([
      "Bearer env-preview",
      "Bearer env-delivery",
      "Bearer env-delivery",
      null,
    ]);
  });

  it("fails the load when the API answers with a non-object or an error", async () => {
    const bad = recordingFetch(() => [1]);
    await expect(
      contentfulSource(
        { contentType: "doc", fetchImpl: bad.fetchImpl, name: "g", space: "s" },
        ctxFor(await tempDir("contentful-bad"))
      ).load()
    ).rejects.toThrow("Contentful returned a non-object response");

    const denied = recordingFetch(
      () => new Response("", { status: 401, statusText: "Unauthorized" })
    );
    await expect(
      contentfulSource(
        {
          contentType: "doc",
          fetchImpl: denied.fetchImpl,
          name: "g",
          space: "s",
        },
        ctxFor(await tempDir("contentful-denied"))
      ).load()
    ).rejects.toThrow("401 Unauthorized");
  });

  it("polls for changes when pollInterval is set", async () => {
    let calls = 0;
    const { fetchImpl } = recordingFetch(() => {
      calls += 1;
      return { items: [entry("a", { title: `v${calls}` })], total: 1 };
    });
    const source = contentfulSource(
      {
        contentType: "doc",
        fetchImpl,
        name: "g",
        pollInterval: 0.01,
        space: "s",
      },
      ctxFor(await tempDir("contentful-poll"), { refresh: false })
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
});

describe("resolveSources (contentful)", () => {
  it("wires a contentful adapter into a staged source without loading", () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [
          contentful({ contentType: "doc", prefix: "cms", space: "s" }),
        ],
      },
    });
    const sources = resolveSources(config, projectContext, { mode: "build" });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.name).toBe("cms");
    expect(sources[0]?.staged).toBe(true);
    expect(sources[0]?.prefix).toBe("cms");
  });
});
