import { afterAll, describe, expect, it } from "bun:test";

import { join } from "pathe";

import { contentfulRichTextToMarkdown } from "../src/core/sources/contentful-rich-text.ts";
import type { JsonObject } from "../src/core/sources/json.ts";
import { lexicalToMarkdown } from "../src/core/sources/lexical.ts";
import {
  guardBlockStart,
  linkParts,
  renderInline,
} from "../src/core/sources/lower.ts";
import type { InlineMarks, InlineRun } from "../src/core/sources/lower.ts";
import { notionSource } from "../src/core/sources/notion.ts";
import type { NotionClientLike } from "../src/core/sources/notion.ts";
import { portableTextToMarkdown } from "../src/core/sources/portable-text.ts";
import { strapiBlocksToMarkdown } from "../src/core/sources/strapi-blocks.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";
import { cleanupTempDirs, ctxFor, tempDir } from "./cms-fixtures.ts";

afterAll(cleanupTempDirs);

/** Render Markdown through both Blume processors; returns [mdx, md] HTML. */
const renderBoth = async (source: string): Promise<string[]> =>
  await Promise.all(
    [blumeMdxProcessor({}), blumeMarkdownProcessor({})].map(
      async (processor) => {
        const renderer = await processor.createRenderer({});
        const { code } = await renderer.render(source);
        return code;
      }
    )
  );

const run = (text: string, marks: InlineMarks = {}): InlineRun => ({
  marks,
  text,
});

const bold = { bold: true };
const italic = { italic: true };
const strike = { strike: true };

describe("neighboring CMS runs with the same marks", () => {
  it("share one set of delimiters instead of printing `****` or `**`", async () => {
    const text = renderInline([
      run("one", bold),
      run("two", bold),
      run(" three", italic),
      run("four", italic),
    ]);
    expect(text).toBe("**onetwo** *threefour*");
    for (const html of await renderBoth(text)) {
      expect(html).toContain("<strong>onetwo</strong> <em>threefour</em>");
    }
  });

  it("keep a code run inside the emphasis it shares, and join code runs", () => {
    expect(
      renderInline([
        run("Run ", bold),
        run("npm", { bold: true, code: true }),
        run(" i", { bold: true, code: true }),
        run(" now", bold),
      ])
    ).toBe("**Run `npm i` now**");
    expect(
      renderInline([run("a", { code: true }), run("b", { code: true })])
    ).toBe("`ab`");
  });

  it("close a mark before whitespace that doesn't carry it", () => {
    expect(renderInline([run("a", strike), run(" "), run("b", strike)])).toBe(
      "~~a~~ ~~b~~"
    );
  });

  it("merge across a link that keeps only its label", () => {
    // oxlint-disable-next-line no-script-url -- the link must be refused
    const unsafe = linkParts([run("two", bold)], "javascript:alert(1)");
    expect(
      renderInline([run("one", bold), ...unsafe, run("three", bold)])
    ).toBe("**onetwothree**");
  });

  it("render one link over neighbors that share it", () => {
    expect(
      renderInline([
        ...linkParts([run("see ", bold), run("docs", bold)], "https://x.dev"),
        run(" now"),
      ])
    ).toBe("[**see docs**](https://x.dev) now");
  });
});

describe("bare URLs in CMS prose", () => {
  it("keep `_`, `~`, and `*` unescaped so the autolink's href is the URL", async () => {
    const text = renderInline([
      run("See https://x.dev/a_b~c*d and www.x.dev/snake_case."),
    ]);
    expect(text).toBe("See https://x.dev/a_b~c*d and www.x.dev/snake_case.");
    for (const html of await renderBoth(text)) {
      expect(html).toContain('href="https://x.dev/a_b~c*d"');
      expect(html).toContain('href="http://www.x.dev/snake_case"');
    }
  });

  it("leave a trailing `_`, `*`, or `~` bare too, outside the link", async () => {
    const text = renderInline([
      run("Open https://x.dev/a_ or https://x.dev/b*~ now"),
    ]);
    expect(text).toBe("Open https://x.dev/a_ or https://x.dev/b*~ now");
    for (const html of await renderBoth(text)) {
      expect(html).toContain('<a href="https://x.dev/a">https://x.dev/a</a>_');
      expect(html).toContain('<a href="https://x.dev/b">https://x.dev/b</a>*~');
    }
  });

  it("escape the same characters outside a URL, or after a scheme GFM doesn't link", () => {
    expect(
      renderInline([run("snake_case ftp://x.dev/*a* xhttps://x.dev/*b*")])
    ).toBe(String.raw`snake\_case ftp://x.dev/\*a\* xhttps://x.dev/\*b\*`);
  });

  it("escape a URL in a link label, where GFM links nothing", async () => {
    const text = renderInline(
      linkParts([run("https://x.dev/*a*_b_")], "https://y.dev")
    );
    expect(text).toBe(String.raw`[https://x.dev/\*a\*\_b\_](https://y.dev)`);
    for (const html of await renderBoth(text)) {
      expect(html).toContain(">https://x.dev/*a*_b_</a>");
    }
  });

  it("leave a URL's `~~~~` to the URL, not the strikethrough seam", () => {
    const text = renderInline([run("https://x.dev/a~~~~b")]);
    expect(guardBlockStart(text)).toBe("https://x.dev/a~~~~b");
  });
});

/** A Contentful text node with the given marks. */
const ctfText = (value: string, ...marks: string[]): JsonObject => ({
  marks: marks.map((type) => ({ type })),
  nodeType: "text",
  value,
});

const ctfNode = (nodeType: string, content: JsonObject[]): JsonObject => ({
  content,
  nodeType,
});

const ctfCell = (...content: JsonObject[]): JsonObject =>
  ctfNode("table-cell", [ctfNode("paragraph", content)]);

describe("Contentful table cells", () => {
  it("go through the same block guard as a paragraph", async () => {
    const md = contentfulRichTextToMarkdown(
      ctfNode("document", [
        ctfNode("table", [
          ctfNode("table-row", [
            ctfCell(ctfText("Change")),
            ctfCell(ctfText("Ref")),
          ]),
          ctfNode("table-row", [
            ctfCell(
              ctfText("one", "strikethrough"),
              ctfText("two", "strikethrough", "bold")
            ),
            ctfCell(ctfText("Issue #")),
          ]),
        ]),
      ])
    );
    expect(md).toBe(
      String.raw`| Change | Ref |
| --- | --- |
| ~~one**two**~~ | Issue \# |
`
    );
    for (const html of await renderBoth(md)) {
      expect(html).toContain("<del>one<strong>two</strong></del>");
      expect(html).toContain("Issue #");
    }
  });
});

/** A bold Lexical text node (`format` 1 is bold). */
const lexicalBold = (text: string) => ({ format: 1, text, type: "text" });

/** A Notion rich-text run. */
const notionRun = (
  plainText: string,
  annotations: { bold?: boolean; italic?: boolean },
  href?: string
) => ({ annotations, href, plain_text: plainText });

describe("every rich-text lowerer merges neighboring runs", () => {
  it("Contentful", () => {
    expect(
      contentfulRichTextToMarkdown(
        ctfNode("document", [
          ctfNode("paragraph", [
            ctfText("one", "bold"),
            ctfText("two", "bold"),
          ]),
        ])
      )
    ).toBe("**onetwo**\n");
  });

  it("Portable Text, with one link over the spans that share it", () => {
    expect(
      portableTextToMarkdown([
        {
          _type: "block",
          children: [
            { _type: "span", marks: ["strong"], text: "one" },
            { _type: "span", marks: ["strong"], text: "two " },
            { _type: "span", marks: ["l1"], text: "see " },
            { _type: "span", marks: ["l1", "em"], text: "docs" },
          ],
          markDefs: [{ _key: "l1", _type: "link", href: "https://x.dev" }],
          style: "normal",
        },
      ])
    ).toBe("**onetwo** [see *docs*](https://x.dev)\n");
  });

  it("Strapi", () => {
    expect(
      strapiBlocksToMarkdown([
        {
          children: [
            { bold: true, text: "one", type: "text" },
            { bold: true, text: "two", type: "text" },
          ],
          type: "paragraph",
        },
      ])
    ).toBe("**onetwo**\n");
  });

  it("Lexical, keeping a line break between runs", () => {
    expect(
      lexicalToMarkdown({
        root: {
          children: [
            {
              children: [
                lexicalBold("one"),
                lexicalBold("two"),
                { type: "linebreak" },
                lexicalBold("three"),
              ],
              type: "paragraph",
            },
          ],
        },
      })
    ).toBe("**onetwo**\n**three**\n");
  });

  it("Notion, with one link over the runs that share it", async () => {
    const client: NotionClientLike = {
      blocks: {
        children: {
          list: () =>
            Promise.resolve({
              has_more: false,
              next_cursor: null,
              results: [
                {
                  id: "p",
                  paragraph: {
                    rich_text: [
                      notionRun("one", { bold: true }),
                      notionRun("two ", { bold: true }),
                      notionRun("see ", {}, "https://x.dev"),
                      notionRun("docs", { italic: true }, "https://x.dev"),
                    ],
                  },
                  type: "paragraph",
                },
              ],
            }),
        },
      },
      dataSources: {
        query: () =>
          Promise.resolve({
            has_more: false,
            next_cursor: null,
            results: [
              {
                id: "page",
                last_edited_time: "2024-08-01T00:00:00Z",
                properties: {
                  Name: { title: [{ plain_text: "Runs" }], type: "title" },
                },
              },
            ],
          }),
      },
      databases: {
        retrieve: () =>
          Promise.resolve({ data_sources: [{ id: "ds1", name: "Handbook" }] }),
      },
    };
    const dir = await tempDir("notion-runs");
    const { entries } = await notionSource(
      { client, database: "db1", name: "handbook" },
      ctxFor(join(dir, "cache"))
    ).load();
    expect(entries[0]?.body.text).toContain(
      "**onetwo** [see *docs*](https://x.dev)"
    );
  });
});
