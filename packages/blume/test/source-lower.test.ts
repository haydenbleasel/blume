import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";

import { join } from "pathe";

import type { JsonObject } from "../src/core/sources/json.ts";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  getPath,
  isStringValue,
  objectsIn,
} from "../src/core/sources/json.ts";
import {
  absoluteUrl,
  blockquote,
  codeFence,
  codeSpan,
  destination,
  escapeMarkdownText,
  headingPrefix,
  image,
  indent,
  joinBlocks,
  listItem,
  linkParts,
  markdownDocument,
  renderInline,
  unsupported,
  writesMdx,
} from "../src/core/sources/lower.ts";
import type { InlineMarks } from "../src/core/sources/lower.ts";
import {
  documentEntry,
  fetchJson,
  queryString,
  remoteSource,
} from "../src/core/sources/remote.ts";
import type { RemoteFieldMap } from "../src/core/sources/remote.ts";
import type { SourceEntry } from "../src/core/sources/types.ts";
import {
  cleanupTempDirs,
  ctxFor,
  recordingFetch,
  tempDir,
} from "./cms-fixtures.ts";

afterAll(cleanupTempDirs);

/** One text run as a lowerer renders it. */
const renderRun = (text: string, marks: InlineMarks): string =>
  renderInline([{ marks, text }]);

/** A link over a plain label, as a lowerer renders one. */
const renderLink = (label: string, href?: string): string =>
  renderInline(linkParts([{ marks: {}, text: label }], href));

describe("json helpers", () => {
  const doc: JsonObject = {
    items: [{ name: "a" }, { name: "b" }],
    meta: { count: 2, title: "T" },
    scalar: "s",
  };

  it("walks dot paths through objects and array indexes", () => {
    expect(getPath(doc, "meta.title")).toBe("T");
    expect(getPath(doc, "items.1.name")).toBe("b");
    expect(getPath(doc, "scalar.deeper")).toBeUndefined();
    expect(getPath(doc, "missing")).toBeUndefined();
  });

  it("narrows scalars, arrays, and objects", () => {
    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();
    expect(isStringValue(null)).toBe(false);
    expect(asNumber(2)).toBe(2);
    expect(asNumber("2")).toBeUndefined();
    expect(asArray([1])).toStrictEqual([1]);
    expect(asArray("no")).toStrictEqual([]);
    expect(asObject({ a: 1 })).toStrictEqual({ a: 1 });
    expect(asObject([1])).toBeUndefined();
    expect(asObject(null)).toBeUndefined();
    expect(objectsIn([{ a: 1 }, "x", null, [2]])).toStrictEqual([{ a: 1 }]);
  });
});

describe("lowering primitives", () => {
  it("wraps marks around the text and keeps edge whitespace outside", () => {
    expect(renderRun("bold ", { bold: true })).toBe("**bold** ");
    expect(renderRun(" both ", { bold: true, italic: true })).toBe(
      " ***both*** "
    );
    expect(renderRun("gone", { strike: true })).toBe("~~gone~~");
    expect(renderRun("a*b", { code: true })).toBe("`a*b`");
    expect(renderRun("x", { bold: true, code: true })).toBe("**`x`**");
    expect(renderRun("a*b_c<d", {})).toBe(String.raw`a\*b\_c\<d`);
    // Braces would open an expression once the entry is written as MDX.
    expect(renderRun("use {id}", {})).toBe(String.raw`use \{id\}`);
  });

  it("keeps a run that starts like block syntax as prose", () => {
    expect(escapeMarkdownText("# not a heading")).toBe(
      String.raw`\# not a heading`
    );
    expect(escapeMarkdownText(">quoted")).toBe(String.raw`\>quoted`);
    expect(escapeMarkdownText("- item")).toBe(String.raw`\- item`);
    expect(escapeMarkdownText("+ item")).toBe(String.raw`\+ item`);
    expect(escapeMarkdownText("1. first")).toBe(String.raw`1\. first`);
    expect(escapeMarkdownText("2) second")).toBe(String.raw`2\) second`);
    // A soft break inside the paragraph is a line start too.
    expect(escapeMarkdownText("a\n- b\n#")).toBe("a\n\\- b\n\\#");
    // Without the space these are ordinary text.
    expect(escapeMarkdownText("#tag -dash 1.5")).toBe("#tag -dash 1.5");
    // A line of `=` or `-` would make the line above a heading, or a rule.
    expect(escapeMarkdownText("Title\n===")).toBe("Title\n\\===");
    expect(escapeMarkdownText("Title\n-- ")).toBe("Title\n\\-- ");
    expect(escapeMarkdownText("---")).toBe(String.raw`\---`);
    expect(escapeMarkdownText("-- text")).toBe("-- text");
  });

  it("keeps a paragraph that opens with import or export out of MDX's ESM", () => {
    expect(escapeMarkdownText("import the CSV first.")).toBe(
      "&#105;mport the CSV first."
    );
    expect(escapeMarkdownText("export your data")).toBe(
      "&#101;xport your data"
    );
    // A blank line starts a new paragraph; a soft break doesn't.
    expect(escapeMarkdownText("a\n\nimport b\nimport c")).toBe(
      "a\n\n&#105;mport b\nimport c"
    );
    // Only the lowercase keyword, as a whole word at a block start, opens a
    // statement.
    expect(escapeMarkdownText("Import it, importing, import\tx")).toBe(
      "Import it, importing, import\tx"
    );
    expect(escapeMarkdownText("importing it")).toBe("importing it");
  });

  it("keeps a character reference typed in the CMS as written", () => {
    expect(escapeMarkdownText("&copy; &#38; AT&T")).toBe(
      String.raw`\&copy; \&#38; AT&T`
    );
  });

  it("picks a code-span delimiter longer than any backtick inside", () => {
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("`x")).toBe("`` `x ``");
    expect(codeSpan("x`")).toBe("`` x` ``");
    expect(renderRun("a``b", { code: true })).toBe("```a``b```");
  });

  it("carries a destination with spaces or parentheses in angle brackets", () => {
    expect(destination("https://x.dev/a b")).toBe("<https://x.dev/a b>");
    expect(destination("https://x.dev/f(1)")).toBe("<https://x.dev/f(1)>");
    expect(renderLink("l", "https://x.dev/a b")).toBe(
      "[l](<https://x.dev/a b>)"
    );
    expect(image("alt", "/img (1).png")).toBe("![alt](</img (1).png>)");
  });

  it("leaves empty and whitespace-only runs alone", () => {
    expect(renderRun("", { bold: true })).toBe("");
    expect(renderRun("  ", { bold: true })).toBe("  ");
  });

  it("renders links, headings, quotes, items, and fences", () => {
    expect(renderLink("label", "https://x.dev")).toBe("[label](https://x.dev)");
    expect(renderLink("label")).toBe("label");
    // CMS content isn't the site author's: a script link keeps its label only.
    // oxlint-disable-next-line no-script-url -- the link must be refused
    expect(renderLink("label", "javascript:alert(1)")).toBe("label");
    expect(renderLink("label", "/guides/a")).toBe("[label](/guides/a)");
    expect(headingPrefix(0)).toBe("# ");
    expect(headingPrefix(9)).toBe("###### ");
    expect(headingPrefix(2.7)).toBe("## ");
    expect(blockquote("a\n\nb")).toBe("> a\n>\n> b");
    expect(listItem("1.", "first\nsecond\n\nthird")).toBe(
      "1. first\n   second\n\n   third"
    );
    expect(indent("a\n\nb", 2)).toBe("  a\n\n  b");
    expect(codeFence("x", "ts")).toBe("```ts\nx\n```");
    expect(codeFence("a ``` b")).toBe("````\na ``` b\n````");
    expect(image("a]b", "/x.png")).toBe(String.raw`![a\]b](/x.png)`);
    expect(unsupported("thing")).toBe("<!-- unsupported thing -->");
    expect(unsupported("thing", true)).toBe("{/* unsupported thing */}");
    expect(joinBlocks(["a", "", "b"])).toBe("a\n\nb");
    expect(markdownDocument(["a"])).toBe("a\n");
  });

  it("makes media URLs absolute", () => {
    expect(absoluteUrl("//images.ctfassets.net/x.png")).toBe(
      "https://images.ctfassets.net/x.png"
    );
    expect(absoluteUrl("https://a.dev/x.png", "https://b.dev")).toBe(
      "https://a.dev/x.png"
    );
    expect(absoluteUrl("/uploads/x.png", "https://b.dev")).toBe(
      "https://b.dev/uploads/x.png"
    );
    expect(absoluteUrl("/uploads/x.png")).toBe("/uploads/x.png");
  });
});

const lower = (): string => "lowered\n";

describe("writesMdx", () => {
  it("switches to MDX only when a serializer is configured", () => {
    expect(writesMdx()).toBe(false);
    expect(writesMdx({})).toBe(false);
    expect(writesMdx({ callout: () => "<Callout />" })).toBe(true);
  });
});

describe("remote helpers", () => {
  const fields: Required<RemoteFieldMap> = {
    body: "body",
    description: "description",
    lastModified: "updatedAt",
    slug: "slug",
    title: "title",
  };

  it("builds a query string without the undefined params", () => {
    expect(queryString({ a: "1", b: undefined, c: "x y" })).toBe("a=1&c=x+y");
  });

  it("fetches JSON and reports a non-2xx status", async () => {
    const ok = recordingFetch(() => ({ ok: true }));
    expect(
      await fetchJson("https://api.test/x", { fetchImpl: ok.fetchImpl })
    ).toStrictEqual({ ok: true });
    expect(ok.calls[0]?.headers.get("accept")).toBe("application/json");
    // Every request carries a deadline so a stalled CMS can't hold a build.
    expect(ok.calls[0]?.signal).toBeInstanceOf(AbortSignal);

    const denied = recordingFetch(
      () => new Response("", { status: 401, statusText: "Unauthorized" })
    );
    await expect(
      fetchJson("https://api.test/x", { fetchImpl: denied.fetchImpl })
    ).rejects.toThrow("https://api.test/x responded 401 Unauthorized");
  });

  it("maps a document to a staged entry with slug fallbacks", () => {
    const full = documentEntry(
      {
        body: { root: {} },
        description: "D",
        slug: "Guides/Getting Started!",
        title: "T",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      fields,
      "id-1",
      lower
    );
    expect(full.ref).toBe("guides/getting-started.md");
    expect(full.data).toStrictEqual({ description: "D", title: "T" });
    expect(full.body.text).toBe("lowered\n");
    expect(full.lastModified).toBe("2026-01-01T00:00:00Z");
    expect(full.raw).toContain("title: T");

    // No slug → the id; a punctuation slug → the id; nothing → untitled.
    expect(documentEntry({}, fields, "doc-a", lower).ref).toBe("doc-a.md");
    expect(documentEntry({ slug: "!!!" }, fields, "doc-b", lower).ref).toBe(
      "doc-b.md"
    );
    expect(documentEntry({ slug: "???" }, fields, "", lower).ref).toBe(
      "untitled.md"
    );
  });

  it("passes a Markdown string body through and marks drafts", () => {
    const entry = documentEntry(
      { body: "# Hi\n\n", slug: "hi", title: 3 },
      fields,
      "x",
      () => "",
      true
    );
    expect(entry.body.text).toBe("# Hi\n");
    expect(entry.data).toStrictEqual({ draft: true });
    expect(entry.raw).toContain("draft: true");
    expect(
      documentEntry({ slug: "no-body" }, fields, "x", () => "").body.text
    ).toBe("");
  });

  it("caches, reads back, and falls back offline", async () => {
    const cacheDir = await tempDir("remote");
    let fail = false;
    const source = remoteSource(
      {
        fetchEntries: () =>
          fail
            ? Promise.reject(new Error("down"))
            : Promise.resolve([
                {
                  body: { format: "md", text: "# A" },
                  data: {},
                  raw: "---\n---\n# A",
                  ref: "a.md",
                },
              ]),
        name: "remote",
        prefix: "r",
      },
      ctxFor(cacheDir)
    );
    expect(source.staged).toBe(true);
    expect(source.prefix).toBe("r");
    expect(source.watch).toBeUndefined();
    const first = await source.load();
    expect(first.entries.map((e) => e.ref)).toStrictEqual(["a.md"]);
    expect(await source.read?.("a.md")).toBe("---\n---\n# A");
    expect(await source.read?.("missing.md")).toBe("");

    fail = true;
    const { diagnostics, entries } = await source.load();
    expect(entries).toHaveLength(1);
    expect(diagnostics.map((d) => d.code)).toStrictEqual([
      "BLUME_SOURCE_OFFLINE",
    ]);
  });

  it("read() serves a cached entry that was never loaded this session", async () => {
    const cacheDir = await tempDir("remote-read");
    const seed: SourceEntry[] = [
      {
        body: { format: "md", text: "# Cached" },
        data: {},
        raw: "---\n---\n# Cached",
        ref: "cached.md",
      },
    ];
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "entries.json"), JSON.stringify(seed));
    const source = remoteSource(
      { fetchEntries: () => Promise.resolve([]), name: "remote" },
      ctxFor(cacheDir)
    );
    expect(await source.read?.("cached.md")).toBe("---\n---\n# Cached");
  });
});
