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
import { normalizeEntry } from "../src/core/sources/normalize.ts";
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

/** An entry whose slug is its id. */
const slugEntry = (id: string): JsonObject => ({
  fields: { slug: id },
  sys: { id, type: "Entry" },
});

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

![A chart](https://images.ctfassets.net/s/chart.png)

<Callout>Entry e1</Callout>

{/* unsupported Contentful embedded entry: widget */}

{/* unsupported Contentful embedded entry */}

| a\\|b | line break |
| --- | --- |
| 1 1b | 2 |

{/* unsupported Contentful node: mystery */}
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
    expect(md).toBe(`![A chart](https://images.ctfassets.net/s/chart.png)

<Callout>Inline</Callout>

# H1

###### H6
`);
  });

  it("uses the asset description as alt, falling back to the title", () => {
    expect(
      assetFromEntry({
        fields: { description: "Desc", file: { url: "/f.png" } },
      })
    ).toStrictEqual({
      contentType: undefined,
      description: "Desc",
      fileName: undefined,
      title: undefined,
      url: "/f.png",
    });
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
    expect(
      contentfulRichTextToMarkdown(
        node("document", [
          node("embedded-asset-block", [], {
            target: { fields: { file: { url: "/f.png" }, title: "Only" } },
          }),
        ])
      )
    ).toBe("![Only](/f.png)\n");
  });

  it("links an entry hyperlink to the route entryHref gives it", () => {
    const md = contentfulRichTextToMarkdown(
      node("document", [
        paragraph(
          node("entry-hyperlink", [text("Install", "bold")], {
            target: slugEntry("install"),
          }),
          text(" "),
          node("entry-hyperlink", [text("resolved")], link("setup", "Entry")),
          text(" "),
          node("entry-hyperlink", [text("no route")], link("other", "Entry")),
          text(" "),
          node("entry-hyperlink", [text("missing")], link("gone", "Entry")),
          text(" "),
          // A node the lowering doesn't know keeps its text too.
          node("resource-hyperlink", [text("resource")], {
            target: {
              sys: {
                linkType: "Contentful:Entry",
                type: "ResourceLink",
                urn: "crn:contentful:::content:spaces/other/entries/e1",
              },
            },
          })
        ),
      ]),
      {
        entryHref: (entry) =>
          getPath(entry, "sys.id") === "other"
            ? undefined
            : `/guides/${asString(getPath(entry, "fields.slug")) ?? ""}`,
        resolveEntry: (id) => (id === "gone" ? null : slugEntry(id)),
      }
    );
    expect(md).toBe(
      "[**Install**](/guides/install) [resolved](/guides/setup) no route missing resource\n"
    );
    // Without entryHref, every entry hyperlink keeps only its text.
    expect(
      contentfulRichTextToMarkdown(
        node("document", [
          paragraph(
            node("entry-hyperlink", [text("text")], {
              target: slugEntry("install"),
            })
          ),
        ])
      )
    ).toBe("text\n");
  });

  it("links an embedded file that isn't an image", () => {
    const file = (fields: JsonObject): JsonObject =>
      node("embedded-asset-block", [], {
        target: {
          fields: {
            file: {
              contentType: "application/pdf",
              fileName: "guide.pdf",
              url: "//assets.ctfassets.net/s/guide.pdf",
            },
            ...fields,
          },
          sys: { id: "pdf" },
        },
      });
    expect(
      contentfulRichTextToMarkdown(
        node("document", [file({ title: "The [guide]" }), file({})])
      )
    ).toBe(
      String.raw`[The \[guide\]](https://assets.ctfassets.net/s/guide.pdf)

[guide.pdf](https://assets.ctfassets.net/s/guide.pdf)
`
    );
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
    // Serializers make lowered rich text MDX; a Markdown string stays `.md`.
    expect(entries.map((e) => [e.ref, e.body.format])).toStrictEqual([
      ["getting-started.mdx", "mdx"],
      ["md.md", "md"],
      ["c.mdx", "mdx"],
      ["untitled.md", "md"],
    ]);
    expect(entries[0]?.data).toStrictEqual({
      description: "Intro",
      title: "Getting Started",
    });
    expect(entries[0]?.body.text).toBe(
      "Hello\n\n![A chart](https://images.ctfassets.net/s/chart.png)\n\n<Callout>Careful</Callout>\n"
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

  it("warns about links the response didn't include, and resolves embeds of its own items", async () => {
    const body = node("document", [
      node("embedded-asset-block", [], link("gone-asset", "Asset")),
      node("embedded-entry-block", [], link("gone-entry", "Entry")),
      node("embedded-entry-block", [], link("gone-entry", "Entry")),
      // `includes` never repeats an entry `items` holds.
      node("embedded-entry-block", [], link("b", "Entry")),
    ]);
    const { fetchImpl } = recordingFetch(() => ({
      items: [entry("a", { body, slug: "a" }), entry("b", { title: "B" })],
      total: 2,
    }));
    const source = contentfulSource(
      {
        contentType: "doc",
        fetchImpl,
        name: "g",
        serializers: {
          doc: (linked) =>
            `<Card title="${asString(getPath(linked, "fields.title")) ?? ""}" />`,
        },
        space: "s",
        token: "delivery",
      },
      ctxFor(await tempDir("contentful-unresolved"))
    );
    const { diagnostics, entries } = await source.load();
    expect(entries[0]?.body.text).toBe(
      '{/* unsupported Contentful embedded entry */}\n\n{/* unsupported Contentful embedded entry */}\n\n<Card title="B" />\n'
    );
    // One warning per missing target, however often the page links it.
    expect(diagnostics.map((d) => [d.code, d.message])).toStrictEqual([
      [
        "BLUME_SOURCE_UNRESOLVED_LINK",
        `Source "g": "a.mdx" links to Contentful asset "gone-asset", which the response didn't include, so the page renders without it.`,
      ],
      [
        "BLUME_SOURCE_UNRESOLVED_LINK",
        `Source "g": "a.mdx" links to Contentful entry "gone-entry", which the response didn't include, so the page renders without it.`,
      ],
    ]);
  });

  it("links an entry hyperlink to its page when the source builds one", async () => {
    const hyperlink = (id: string, label: string): JsonObject =>
      node("entry-hyperlink", [text(label)], link(id, "Entry"));
    const body = node("document", [
      paragraph(
        hyperlink("b", "same response"),
        text(", "),
        hyperlink("c", "next page"),
        text(", "),
        hyperlink("d", "no slug"),
        text(", "),
        hyperlink("note-1", "other type"),
        text(", "),
        hyperlink("filtered", "filtered out"),
        text(", "),
        hyperlink("gone", "unpublished")
      ),
    ]);
    const note: JsonObject = {
      fields: { label: "Careful" },
      sys: { contentType: { sys: { id: "callout" } }, id: "note-1" },
    };
    const later = [entry("c", { slug: "SDK/Set up" }), entry("d", {})];
    const { fetchImpl } = recordingFetch(({ url }): JsonValue => {
      if (url.searchParams.get("skip") === "0") {
        return {
          // `includes` carries the entries a later page delivers, and one of
          // the source's own type that `params` keeps off the site; never
          // one this page's `items` hold.
          includes: {
            Entry: [note, ...later, entry("filtered", { slug: "hidden" })],
          },
          items: [
            entry("a", { body, slug: "intro" }),
            entry("b", { slug: "install" }),
          ],
          total: 4,
        };
      }
      return { items: later, total: 4 };
    });
    const source = contentfulSource(
      {
        contentType: "doc",
        fetchImpl,
        name: "guides",
        params: { "fields.section": "sdk" },
        prefix: "guides",
        space: "s",
        token: "delivery",
      },
      ctxFor(await tempDir("contentful-hyperlink"))
    );
    const { diagnostics, entries } = await source.load();
    expect(entries.map((e) => e.ref)).toStrictEqual([
      "intro.md",
      "install.md",
      "sdk/set-up.md",
      "d.md",
    ]);
    // Each link matches the page its entry is staged as, under the prefix.
    expect(entries[0]?.body.text).toBe(
      "[same response](/guides/install), [next page](/guides/sdk/set-up), [no slug](/guides/d), other type, filtered out, unpublished\n"
    );
    // An unpublished target warns like an unpublished embed.
    expect(diagnostics.map((d) => [d.code, d.message])).toStrictEqual([
      [
        "BLUME_SOURCE_UNRESOLVED_LINK",
        `Source "guides": "intro.md" links to Contentful entry "gone", which the response didn't include, so the page renders without it.`,
      ],
    ]);
  });

  it("links an entry hyperlink to the route the page publishes at, drafts included", async () => {
    const body = node("document", [
      paragraph(
        node("entry-hyperlink", [text("Setup")], link("setup", "Entry")),
        text(" / "),
        node("entry-hyperlink", [text("Accueil")], link("fr-home", "Entry")),
        text(" / "),
        node("entry-hyperlink", [text("v1")], link("old", "Entry"))
      ),
    ]);
    // Under --preview the Preview API answers, drafts among its entries, and
    // they link the same way.
    const { calls, fetchImpl } = recordingFetch(() => ({
      items: [
        entry("home", { body, slug: "index" }),
        entry("setup", { slug: "setup" }),
        entry("fr-home", { slug: "fr/index" }),
        entry("old", { slug: "v1/setup" }),
      ],
      total: 4,
    }));
    const { i18n, versions } = blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "en",
        hideDefaultLocalePrefix: false,
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "Français" },
        ],
      },
      versions: { archived: [{ id: "v1" }], current: { label: "v2" } },
    });
    const source = contentfulSource(
      {
        contentType: "doc",
        fetchImpl,
        i18n,
        name: "cms",
        prefix: "cms",
        previewToken: "preview",
        space: "s",
        versions,
      },
      ctxFor(await tempDir("contentful-hyperlink-routes"), { preview: true })
    );
    const { entries } = await source.load();
    expect(calls[0]?.url.origin).toBe("https://preview.contentful.com");
    // The routes the pipeline gives the linked pages.
    const routes = new Map(
      entries.flatMap((staged) =>
        normalizeEntry(staged, {
          defaultType: "docs",
          i18n,
          source: { name: "cms", prefix: "cms", staged: true },
          versions,
        }).pages.map((page) => [staged.ref, page.route])
      )
    );
    expect(routes.get("setup.md")).toBe("/en/cms/setup");
    expect(routes.get("fr/index.md")).toBe("/fr/cms");
    expect(routes.get("v1/setup.md")).toBe("/en/v1/cms/setup");
    expect(entries[0]?.body.text).toBe(
      "[Setup](/en/cms/setup) / [Accueil](/fr/cms) / [v1](/en/v1/cms/setup)\n"
    );
  });

  it("reads an EU data residency space from its hosts", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({
      items: [],
      total: 0,
    }));
    const options = {
      contentType: "doc",
      fetchImpl,
      host: "cdn.eu.contentful.com",
      name: "g",
      previewHost: "preview.eu.contentful.com",
      previewToken: "preview",
      space: "s",
      token: "delivery",
    };
    await contentfulSource(
      options,
      ctxFor(await tempDir("contentful-eu"))
    ).load();
    await contentfulSource(
      options,
      ctxFor(await tempDir("contentful-eu"), { preview: true })
    ).load();
    expect(calls.map((call) => call.url.origin)).toStrictEqual([
      "https://cdn.eu.contentful.com",
      "https://preview.eu.contentful.com",
    ]);
  });

  it("reads the sidebar order from a mapped field", async () => {
    const { fetchImpl } = recordingFetch(() => ({
      items: [
        entry("a", { position: 3, slug: "a" }),
        entry("b", { position: "3", slug: "b" }),
      ],
      total: 2,
    }));
    const source = contentfulSource(
      {
        contentType: "doc",
        fetchImpl,
        fields: { order: "position" },
        name: "g",
        space: "s",
        token: "delivery",
      },
      ctxFor(await tempDir("contentful-order"))
    );
    const { entries } = await source.load();
    // Only a number is an order.
    expect(entries.map((e) => e.data)).toStrictEqual([
      { sidebar: { order: 3 } },
      {},
    ]);
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

  it("falls back to the env tokens, and fails before a request without one", async () => {
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
      // Preview never borrows the delivery token: the Preview API rejects it.
      await expect(
        contentfulSource(
          options,
          ctxFor(await tempDir("contentful-env"), { preview: true })
        ).load()
      ).rejects.toThrow("needs a Preview API token");
    });
    // The Delivery API answers nothing without a token, so its absence is
    // reported as the variable to set, not as the API's 401.
    await withEnv("CONTENTFUL_ACCESS_TOKEN", undefined, async () => {
      await expect(
        contentfulSource(
          options,
          ctxFor(await tempDir("contentful-env"))
        ).load()
      ).rejects.toMatchObject({
        diagnostic: {
          code: "BLUME_MISSING_SECRET",
          message:
            'Source "g" needs CONTENTFUL_ACCESS_TOKEN, which is not set.',
        },
      });
    });
    expect(
      calls.map((call) => call.headers.get("authorization"))
    ).toStrictEqual(["Bearer env-preview", "Bearer env-delivery"]);
  });

  it("fails the load when the API answers with a non-object or an error", async () => {
    const bad = recordingFetch(() => [1]);
    await expect(
      contentfulSource(
        {
          contentType: "doc",
          fetchImpl: bad.fetchImpl,
          name: "g",
          space: "s",
          token: "delivery",
        },
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
          token: "delivery",
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
        token: "delivery",
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

  it("places entry hyperlinks by the project's i18n config", async () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [
          contentful({ contentType: "doc", prefix: "cms", space: "s" }),
        ],
      },
      i18n: {
        defaultLocale: "en",
        hideDefaultLocalePrefix: false,
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "Français" },
        ],
      },
    });
    const outDir = await tempDir("contentful-resolve");
    const [source] = resolveSources(
      config,
      { ...projectContext, outDir, root: outDir },
      { mode: "build" }
    );
    const { fetchImpl } = recordingFetch(() => ({
      items: [
        entry("a", {
          body: node("document", [
            paragraph(node("entry-hyperlink", [text("B")], link("b", "Entry"))),
          ]),
          slug: "a",
        }),
        entry("b", { slug: "b" }),
      ],
      total: 2,
    }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await withEnv("CONTENTFUL_ACCESS_TOKEN", "delivery", async () => {
        const { entries } = (await source?.load()) ?? { entries: [] };
        expect(entries[0]?.body.text).toBe("[B](/en/cms/b)\n");
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
