import { afterAll, describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import type { JsonObject, JsonValue } from "../src/core/sources/json.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import { strapiBlocksToMarkdown } from "../src/core/sources/strapi-blocks.ts";
import { strapiSource } from "../src/core/sources/strapi.ts";
import { strapi } from "../src/sources/strapi.ts";
import {
  cleanupTempDirs,
  ctxFor,
  projectContext,
  recordingFetch,
  tempDir,
  withEnv,
} from "./cms-fixtures.ts";

afterAll(cleanupTempDirs);

const text = (value: string, marks: JsonObject = {}): JsonObject => ({
  text: value,
  type: "text",
  ...marks,
});

const el = (
  type: string,
  children: JsonValue[],
  extra: JsonObject = {}
): JsonObject => ({ children, type, ...extra });

describe("strapiBlocksToMarkdown", () => {
  it("renders every block the Blocks editor emits", () => {
    const md = strapiBlocksToMarkdown(
      [
        el("heading", [text("Title")], { level: 2 }),
        el("paragraph", [
          text("plain "),
          text("bold", { bold: true }),
          text(" "),
          text("em", { italic: true }),
          text(" "),
          text("gone", { strikethrough: true }),
          text(" "),
          text("under", { underline: true }),
          text(" "),
          text("a*b", { code: true }),
          text(" "),
          el("link", [text("site")], { url: "https://x.dev" }),
          text(" "),
          el("link", [text("nowhere")]),
          text(" "),
          el("mystery-inline", [text("kept")]),
        ]),
        el("quote", [text("quoted")]),
        el(
          "list",
          [
            el("list-item", [
              text("one"),
              el("list", [el("list-item", [text("nested")])], {
                format: "ordered",
              }),
            ]),
            el("list-item", [text("two")]),
          ],
          { format: "unordered" }
        ),
        el("list", [el("list-item", [text("first")])], { format: "ordered" }),
        el("code", [text("const a = `x`;")], { language: "ts" }),
        el("code", [text("plain")]),
        el("image", [text("")], {
          image: { alternativeText: "Alt", url: "/uploads/a.png" },
        }),
        el("image", [], { image: { name: "b.png", url: "https://cdn/b.png" } }),
        el("image", [], { image: {} }),
        el("image", [], {}),
        el("heading", [text("No level")]),
        el("mystery", []),
      ],
      { baseUrl: "https://cms.test" }
    );
    expect(md).toBe(`## Title

plain **bold** *em* ~~gone~~ under \`a*b\` [site](https://x.dev) nowhere kept

> quoted

- one
  1. nested
- two

1. first

\`\`\`ts
const a = \`x\`;
\`\`\`

\`\`\`
plain
\`\`\`

![Alt](https://cms.test/uploads/a.png)

![b.png](https://cdn/b.png)

# No level

<!-- unsupported Strapi block: mystery -->
`);
  });

  it("renders nothing for a value that is not a block array", () => {
    expect(strapiBlocksToMarkdown("text")).toBe("\n");
  });
});

describe("strapiSource", () => {
  it("pages through a Strapi 5 content type and lowers each entry", async () => {
    const { calls, fetchImpl } = recordingFetch(({ url }): JsonValue => {
      const page = Number(url.searchParams.get("pagination[page]"));
      if (page === 1) {
        return {
          data: [
            {
              content: [
                el("paragraph", [text("Hello")]),
                el("image", [], { image: { url: "/uploads/a.png" } }),
              ],
              description: "Intro",
              documentId: "abc",
              publishedAt: "2026-04-01T00:00:00Z",
              slug: "getting-started",
              title: "Getting Started",
              updatedAt: "2026-04-02T00:00:00Z",
            },
          ],
          meta: { pagination: { page: 1, pageCount: 2 } },
        };
      }
      return {
        data: [{ content: "# Markdown\n", documentId: "def", title: "MD" }],
        meta: { pagination: { page: 2, pageCount: 2 } },
      };
    });
    const source = strapiSource(
      {
        contentType: "docs",
        fetchImpl,
        locale: "en",
        name: "cms",
        params: { "filters[section][$eq]": "sdk" },
        populate: "image",
        prefix: "cms",
        token: "tok",
        url: "https://cms.test/",
      },
      ctxFor(await tempDir("strapi"))
    );

    const { entries } = await source.load();
    expect(entries.map((e) => e.ref)).toStrictEqual([
      "getting-started.md",
      "def.md",
    ]);
    expect(entries[0]?.data).toStrictEqual({
      description: "Intro",
      title: "Getting Started",
    });
    expect(entries[0]?.body.text).toBe(
      "Hello\n\n![](https://cms.test/uploads/a.png)\n"
    );
    expect(entries[0]?.lastModified).toBe("2026-04-02T00:00:00Z");
    expect(entries[1]?.body.text).toBe("# Markdown\n");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.origin).toBe("https://cms.test");
    expect(calls[0]?.url.pathname).toBe("/api/docs");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toStrictEqual({
      "filters[section][$eq]": "sdk",
      locale: "en",
      "pagination[pageSize]": "100",
      "pagination[page]": "1",
      populate: "image",
    });
    expect(calls[1]?.url.searchParams.get("pagination[page]")).toBe("2");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("flattens the Strapi 4 envelope and marks drafts under --preview", async () => {
    const { calls, fetchImpl } = recordingFetch((): JsonValue => ({
      data: [
        {
          attributes: { publishedAt: null, slug: "draft", title: "Draft" },
          id: 12,
        },
        { attributes: { title: "Live" }, id: 13 },
        { publishedAt: null, title: "No id" },
      ],
      meta: { pagination: { page: 1, pageCount: 1 } },
    }));
    const source = strapiSource(
      { contentType: "docs", fetchImpl, name: "cms", url: "https://cms.test" },
      ctxFor(await tempDir("strapi-preview"), { preview: true })
    );
    const { entries } = await source.load();
    expect(entries.map((e) => e.ref)).toStrictEqual([
      "draft.md",
      "13.md",
      "untitled.md",
    ]);
    expect(entries[0]?.data).toStrictEqual({ draft: true, title: "Draft" });
    expect(entries[1]?.data).toStrictEqual({ title: "Live" });
    expect(calls[0]?.url.searchParams.get("status")).toBe("draft");
    expect(calls[0]?.url.searchParams.get("populate")).toBe("*");
  });

  it("reads the API token from the environment, else sends no auth header", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ data: [] }));
    const options = {
      contentType: "docs",
      fetchImpl,
      name: "cms",
      url: "https://cms.test",
    };
    await withEnv("STRAPI_API_TOKEN", "env-tok", async () => {
      await strapiSource(options, ctxFor(await tempDir("strapi-env"))).load();
    });
    await withEnv("STRAPI_API_TOKEN", undefined, async () => {
      await strapiSource(options, ctxFor(await tempDir("strapi-env"))).load();
    });
    expect(
      calls.map((call) => call.headers.get("authorization"))
    ).toStrictEqual(["Bearer env-tok", null]);
  });

  it("fails the load when the API answers with a non-object", async () => {
    const { fetchImpl } = recordingFetch(() => null);
    await expect(
      strapiSource(
        {
          contentType: "docs",
          fetchImpl,
          name: "cms",
          url: "https://cms.test",
        },
        ctxFor(await tempDir("strapi-bad"))
      ).load()
    ).rejects.toThrow("Strapi returned a non-object response");
  });
});

describe("resolveSources (strapi)", () => {
  it("wires a strapi adapter into a staged source without loading", () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [
          strapi({
            contentType: "docs",
            prefix: "cms",
            url: "https://cms.test",
          }),
        ],
      },
    });
    const sources = resolveSources(config, projectContext, { mode: "build" });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.name).toBe("cms");
    expect(sources[0]?.staged).toBe(true);
  });
});
