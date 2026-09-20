import { afterAll, describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import type { JsonObject, JsonValue } from "../src/core/sources/json.ts";
import { lexicalToMarkdown } from "../src/core/sources/lexical.ts";
import { payloadSource } from "../src/core/sources/payload.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import { payload } from "../src/sources/payload.ts";
import {
  cleanupTempDirs,
  ctxFor,
  projectContext,
  recordingFetch,
  tempDir,
  withEnv,
} from "./cms-fixtures.ts";

afterAll(cleanupTempDirs);

const text = (value: string, format = 0): JsonObject => ({
  format,
  text: value,
  type: "text",
});

const el = (
  type: string,
  children: JsonValue[],
  extra: JsonObject = {}
): JsonObject => ({ children, type, ...extra });

const item = (children: JsonValue[], extra: JsonObject = {}): JsonObject =>
  el("listitem", children, extra);

describe("lexicalToMarkdown", () => {
  it("renders the nodes Payload's default features emit", () => {
    const md = lexicalToMarkdown(
      {
        root: el("root", [
          el("heading", [text("Title")], { tag: "h3" }),
          el("paragraph", [
            text("plain "),
            text("bold", 1),
            text(" "),
            text("em", 2),
            text(" "),
            text("gone", 4),
            text(" "),
            text("under", 8),
            text(" "),
            text("a*b", 16),
            text(" "),
            text("both", 3),
            { type: "linebreak" },
            { type: "tab" },
            el("link", [text("site")], { fields: { url: "https://x.dev" } }),
            text(" "),
            el("link", [text("old")], { url: "https://old.dev" }),
            text(" "),
            el("link", [text("internal")], {
              fields: { doc: { value: "1" }, linkType: "internal" },
            }),
            text(" "),
            el("autolink", [text("auto")], {
              fields: { url: "https://a.dev" },
            }),
            text(" "),
            el("inlineBlock", [], {
              fields: { blockType: "badge", label: "New" },
            }),
            text(" "),
            el("inlineBlock", [], { fields: { blockType: "unknown" } }),
            text(" "),
            el("mystery-inline", [text("kept")]),
          ]),
          el("quote", [text("q1"), { type: "linebreak" }, text("q2")]),
          el("list", [item([text("one")]), item([text("two")])], {
            listType: "bullet",
          }),
          el(
            "list",
            [
              item([text("three")], { value: 3 }),
              item([
                el("list", [item([text("nested")])], { listType: "bullet" }),
              ]),
              item([
                text("four"),
                el("list", [item([text("inline nested")])], {
                  listType: "bullet",
                }),
              ]),
            ],
            { listType: "number", start: 3 }
          ),
          el(
            "list",
            [
              item([
                el("list", [item([text("leading nested")])], {
                  listType: "bullet",
                }),
              ]),
              item([text("done")], { checked: true }),
              item([text("todo")]),
            ],
            { listType: "check" }
          ),
          { type: "horizontalrule" },
          el("upload", [], {
            relationTo: "media",
            value: { alt: "Alt", url: "/media/a.png" },
          }),
          el("upload", [], {
            value: { filename: "b.png", url: "https://cdn/b.png" },
          }),
          el("upload", [], { value: "id-only" }),
          el("block", [], { fields: { blockType: "code", code: "x" } }),
          el("block", [], { fields: { blockType: "video" } }),
          el("block", [], {}),
          el("mystery", []),
        ]),
      },
      {
        baseUrl: "https://cms.test",
        serializers: {
          badge: (fields) => `<Badge>${String(fields.label)}</Badge>`,
          code: (fields) => `\`\`\`\n${String(fields.code)}\n\`\`\``,
        },
      }
    );
    expect(md).toBe(`### Title

plain **bold** *em* ~~gone~~ under \`a*b\` ***both***
\t[site](https://x.dev) [old](https://old.dev) internal [auto](https://a.dev) <Badge>New</Badge> <!-- unsupported Lexical block: unknown --> kept

> q1
> q2

- one
- two

3. three
   - nested
4. four
   - inline nested

- leading nested
- [x] done
- [ ] todo

---

![Alt](https://cms.test/media/a.png)

![b.png](https://cdn/b.png)

<!-- unsupported Lexical upload (fetch with depth 1 to populate it) -->

\`\`\`
x
\`\`\`

<!-- unsupported Lexical block: video -->

<!-- unsupported Lexical block -->

<!-- unsupported Lexical node: mystery -->
`);
  });

  it("accepts the root node itself and a heading without a tag", () => {
    expect(lexicalToMarkdown(el("root", [el("heading", [text("H")])]))).toBe(
      "# H\n"
    );
  });
});

const doc = (id: JsonValue, fields: JsonObject): JsonObject => ({
  id,
  updatedAt: "2026-03-01T00:00:00Z",
  ...fields,
});

describe("payloadSource", () => {
  it("pages through the collection and lowers each document", async () => {
    const { calls, fetchImpl } = recordingFetch(({ url }): JsonValue => {
      const page = Number(url.searchParams.get("page"));
      if (page === 1) {
        return {
          docs: [
            doc("a", {
              _status: "published",
              content: {
                root: el("root", [
                  el("paragraph", [text("Hello")]),
                  el("upload", [], {
                    value: { alt: "A", url: "/media/a.png" },
                  }),
                ]),
              },
              description: "Intro",
              slug: "getting-started",
              title: "Getting Started",
            }),
            doc("b", { _status: "draft", slug: "draft", title: "Draft" }),
          ],
          hasNextPage: true,
        };
      }
      return {
        docs: [doc(7, { content: "# Markdown\n", title: "Seven" })],
        hasNextPage: false,
      };
    });
    const source = payloadSource(
      {
        collection: "docs",
        fetchImpl,
        name: "cms",
        params: { sort: "title" },
        prefix: "cms",
        token: "key",
        url: "https://cms.test/",
      },
      ctxFor(await tempDir("payload"))
    );

    const { entries } = await source.load();
    expect(entries.map((e) => e.ref)).toStrictEqual([
      "getting-started.md",
      "7.md",
    ]);
    expect(entries[0]?.data).toStrictEqual({
      description: "Intro",
      title: "Getting Started",
    });
    expect(entries[0]?.body.text).toBe(
      "Hello\n\n![A](https://cms.test/media/a.png)\n"
    );
    expect(entries[0]?.lastModified).toBe("2026-03-01T00:00:00Z");
    expect(entries[1]?.body.text).toBe("# Markdown\n");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.origin).toBe("https://cms.test");
    expect(calls[0]?.url.pathname).toBe("/api/docs");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toStrictEqual({
      depth: "1",
      limit: "100",
      page: "1",
      sort: "title",
    });
    expect(calls[1]?.url.searchParams.get("page")).toBe("2");
    expect(calls[0]?.headers.get("authorization")).toBe("users API-Key key");
  });

  it("keeps drafts under --preview and names the auth collection", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({
      docs: [doc("b", { _status: "draft", slug: "draft", title: "Draft" })],
      hasNextPage: false,
    }));
    const source = payloadSource(
      {
        authCollection: "editors",
        collection: "docs",
        depth: 2,
        fetchImpl,
        name: "cms",
        token: "key",
        url: "https://cms.test",
      },
      ctxFor(await tempDir("payload-preview"), { preview: true })
    );
    const { entries } = await source.load();
    expect(entries[0]?.data).toStrictEqual({ draft: true, title: "Draft" });
    expect(calls[0]?.url.searchParams.get("draft")).toBe("true");
    expect(calls[0]?.url.searchParams.get("depth")).toBe("2");
    expect(calls[0]?.headers.get("authorization")).toBe("editors API-Key key");
  });

  it("reads the API key from the environment, else sends no auth header", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({
      docs: [],
      hasNextPage: false,
    }));
    const options = {
      collection: "docs",
      fetchImpl,
      name: "cms",
      url: "https://cms.test",
    };
    await withEnv("PAYLOAD_API_KEY", "env-key", async () => {
      await payloadSource(options, ctxFor(await tempDir("payload-env"))).load();
    });
    await withEnv("PAYLOAD_API_KEY", undefined, async () => {
      await payloadSource(options, ctxFor(await tempDir("payload-env"))).load();
    });
    expect(
      calls.map((call) => call.headers.get("authorization"))
    ).toStrictEqual(["users API-Key env-key", null]);
  });

  it("fails the load when the API answers with a non-object", async () => {
    const { fetchImpl } = recordingFetch(() => "nope");
    await expect(
      payloadSource(
        { collection: "docs", fetchImpl, name: "cms", url: "https://cms.test" },
        ctxFor(await tempDir("payload-bad"))
      ).load()
    ).rejects.toThrow("Payload returned a non-object response");
  });
});

describe("resolveSources (payload)", () => {
  it("wires a payload adapter into a staged source without loading", () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [
          payload({
            collection: "docs",
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
