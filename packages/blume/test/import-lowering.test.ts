import { describe, expect, it } from "bun:test";

import { contentfulRichTextToMarkdown } from "../src/core/sources/contentful-rich-text.ts";
import type { JsonObject } from "../src/core/sources/json.ts";
import { lexicalToMarkdown } from "../src/core/sources/lexical.ts";
import {
  codeFence,
  escapeMarkdownText,
  guardBlockStart,
  unsupported,
} from "../src/core/sources/lower.ts";
import { portableTextToMarkdown } from "../src/core/sources/portable-text.ts";
import type { PortableTextBlock } from "../src/core/sources/portable-text.ts";
import { strapiBlocksToMarkdown } from "../src/core/sources/strapi-blocks.ts";

const span = (text: string, marks: string[] = []) => ({
  _type: "span",
  marks,
  text,
});

const ptBlock = (
  children: ReturnType<typeof span>[],
  extra: Partial<PortableTextBlock> = {}
): PortableTextBlock => ({
  _type: "block",
  children,
  style: "normal",
  ...extra,
});

describe("portableTextToMarkdown: code marks", () => {
  it("keeps a code span's text inside its delimiters", () => {
    const md = portableTextToMarkdown([
      ptBlock([span("a`<img src=x onerror=alert(1)>`b", ["code"])]),
    ]);
    // The delimiter outruns the backticks inside, so the tag stays code.
    expect(md).toBe("``a`<img src=x onerror=alert(1)>`b``\n");
  });

  it("keeps braces in code and prose from opening an MDX expression", () => {
    const md = portableTextToMarkdown(
      [
        ptBlock([
          span("a`{process.env.SANITY_TOKEN}`b", ["code"]),
          span(" and {process.env.SANITY_TOKEN}"),
        ]),
      ],
      { serializers: { callout: () => "<Callout />" } }
    );
    expect(md).toBe(
      "``a`{process.env.SANITY_TOKEN}`b`` and \\{process.env.SANITY\\_TOKEN\\}\n"
    );
  });
});

const item = (text: string, listItem: string, level: number) =>
  ptBlock([span(text)], { level, listItem });

describe("portableTextToMarkdown: emphasis and lists", () => {
  it("keeps a span's edge whitespace outside its emphasis", () => {
    const md = portableTextToMarkdown([
      ptBlock([span("Hello ", ["strong"]), span(" there", ["em"]), span("!")]),
    ]);
    expect(md).toBe("**Hello**  *there*!\n");
  });

  it("indents a nested item to its parent's content column", () => {
    const md = portableTextToMarkdown([
      item("one", "number", 1),
      item("child", "number", 2),
      item("grand", "bullet", 3),
      item("two", "bullet", 1),
      // A skipped level nests under the deepest open item, not into code.
      item("deep", "bullet", 3),
      item("level two", "number", 2),
    ]);
    expect(md).toBe(
      [
        "1. one",
        "   1. child",
        "      - grand",
        "- two",
        "  - deep",
        "  1. level two",
        "",
      ].join("\n")
    );
  });

  it("starts a list over after a paragraph", () => {
    const md = portableTextToMarkdown([
      ptBlock([span("a")], { level: 2, listItem: "bullet" }),
      ptBlock([span("between")]),
      ptBlock([span("b")], { level: 1, listItem: "bullet" }),
    ]);
    expect(md).toBe("- a\n\nbetween\n\n- b\n");
  });
});

describe("guardBlockStart", () => {
  it("escapes an ESM keyword that only forms once runs are joined", () => {
    expect(guardBlockStart("import `lodash`")).toBe("&#105;mport `lodash`");
    expect(guardBlockStart("export**x**")).toBe("&#101;xport**x**");
    expect(guardBlockStart("import\tx")).toBe("&#105;mport\tx");
    expect(guardBlockStart("import")).toBe("&#105;mport");
    expect(guardBlockStart("a\n\nexport {x}")).toBe("a\n\n&#101;xport {x}");
    // A soft break can't open a statement, and a longer word isn't the keyword.
    expect(guardBlockStart("a\nimport x")).toBe("a\nimport x");
    expect(guardBlockStart("importer x")).toBe("importer x");
  });

  it("drops the indentation that would open a code block", () => {
    expect(guardBlockStart("    four")).toBe("four");
    expect(guardBlockStart("\ttabbed")).toBe("tabbed");
    expect(guardBlockStart("a\n\n    b")).toBe("a\n\nb");
    // Indentation after a soft break continues the paragraph and stays.
    expect(guardBlockStart("a\n    b")).toBe("a\n    b");
    expect(guardBlockStart("  import x")).toBe("&#105;mport x");
  });
});

describe("escapeMarkdownText: block starts", () => {
  it("keeps a run of hashes and an indented marker as prose", () => {
    expect(escapeMarkdownText("## Not a heading")).toBe(
      String.raw`\## Not a heading`
    );
    expect(escapeMarkdownText("###### six")).toBe(String.raw`\###### six`);
    // A heading, quote, or list can interrupt a paragraph, indented or not.
    expect(escapeMarkdownText("a\n  # b\n   > c\n  1. d")).toBe(
      "a\n  \\# b\n   \\> c\n  1\\. d"
    );
    expect(escapeMarkdownText("a\n  ===")).toBe("a\n  \\===");
  });
});

describe("codeFence: languages", () => {
  it("drops a language a fence can't carry", () => {
    expect(codeFence("<img src=x onerror=alert(1)>", "js`")).toBe(
      "```\n<img src=x onerror=alert(1)>\n```"
    );
    expect(codeFence("x", "plain text")).toBe("```\nx\n```");
    expect(codeFence("x", "ts\ntitle")).toBe("```\nx\n```");
    expect(codeFence("x", "c++")).toBe("```c++\nx\n```");
  });
});

describe("unsupported: node types from CMS data", () => {
  it("keeps a type's comment terminator inside the comment", () => {
    expect(unsupported("block: x */}{process.env.X}{/* y", true)).toBe(
      "{/* unsupported block: x * /}{process.env.X}{/* y */}"
    );
    expect(unsupported("block: x --><script>", false)).toBe(
      "<!-- unsupported block: x - -><script> -->"
    );
  });

  it("neutralizes a Portable Text block type", () => {
    const md = portableTextToMarkdown(
      [{ _type: "x */}{process.env.SANITY_TOKEN}{/*" }],
      { serializers: { callout: () => "" } }
    );
    expect(md).toBe(
      "{/* unsupported Portable Text block: x * /}{process.env.SANITY_TOKEN}{/* */}\n"
    );
  });
});

/** A Lexical text node; `format` is its mark bitmask (16 is code). */
const lexicalText = (value: string, format = 0) => ({
  format,
  text: value,
  type: "text",
});

describe("rich-text lowerers: block-level guards", () => {
  it("Lexical guards paragraphs, headings, quotes, and list items", () => {
    const guarded = [lexicalText("import "), lexicalText("lodash", 16)];
    const md = lexicalToMarkdown({
      root: {
        children: [
          { children: guarded, type: "paragraph" },
          {
            children: [{ type: "tab" }, lexicalText("tabbed")],
            type: "paragraph",
          },
          { children: guarded, tag: "h2", type: "heading" },
          { children: guarded, type: "quote" },
          {
            children: [{ children: guarded, type: "listitem" }],
            listType: "bullet",
            type: "list",
          },
        ],
      },
    });
    expect(md).toBe(
      [
        "&#105;mport `lodash`",
        "tabbed",
        "## &#105;mport `lodash`",
        "> &#105;mport `lodash`",
        "- &#105;mport `lodash`\n",
      ].join("\n\n")
    );
  });

  it("Strapi guards paragraphs, headings, quotes, and list items", () => {
    const guarded: JsonObject[] = [
      { text: "import ", type: "text" },
      { code: true, text: "lodash", type: "text" },
    ];
    const md = strapiBlocksToMarkdown([
      { children: guarded, type: "paragraph" },
      { children: guarded, level: 2, type: "heading" },
      { children: guarded, type: "quote" },
      {
        children: [{ children: guarded, type: "list-item" }],
        format: "unordered",
        type: "list",
      },
      {
        children: [{ text: "<img src=x onerror=alert(1)>", type: "text" }],
        language: "js`",
        type: "code",
      },
    ]);
    expect(md).toBe(
      [
        "&#105;mport `lodash`",
        "## &#105;mport `lodash`",
        "> &#105;mport `lodash`",
        "- &#105;mport `lodash`",
        "```\n<img src=x onerror=alert(1)>\n```\n",
      ].join("\n\n")
    );
  });

  it("Contentful guards paragraphs and headings", () => {
    const guarded: JsonObject[] = [
      { marks: [], nodeType: "text", value: "import " },
      { marks: [{ type: "code" }], nodeType: "text", value: "lodash" },
    ];
    const md = contentfulRichTextToMarkdown({
      content: [
        { content: guarded, nodeType: "paragraph" },
        { content: guarded, nodeType: "heading-2" },
      ],
      nodeType: "document",
    });
    expect(md).toBe("&#105;mport `lodash`\n\n## &#105;mport `lodash`\n");
  });
});
