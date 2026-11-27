import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { scanProject } from "../src/core/project-graph.ts";
import type { SourceEntry } from "../src/core/sources/types.ts";
import {
  indexPageNames,
  syntaxDiagnostics,
} from "../src/core/syntax-diagnostics.ts";
import type { PageRecord } from "../src/core/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** An entry with this body, in `format`. */
const entry = (
  text: string,
  format: "md" | "mdx" = "md",
  over: Partial<SourceEntry> = {}
): SourceEntry => ({
  body: { format, text },
  data: {},
  ref: `guide.${format}`,
  sourcePath: `/docs/guide.${format}`,
  ...over,
});

/** The code, line, and column of each diagnostic for a body. */
const found = (
  text: string,
  format: "md" | "mdx" = "md",
  pages: PageRecord[] = []
) =>
  syntaxDiagnostics(
    entry(text, format),
    "docs",
    indexPageNames(pages),
    "en"
  ).map(({ code, column, line }) => ({ code, column, line }));

const page = (over: Partial<PageRecord>): PageRecord =>
  // SAFETY: the name index reads only the fields a fixture sets (source,
  // title, locale, route); the remaining PageRecord fields go unread.
  ({
    locale: "",
    route: "/p",
    source: { name: "docs", ref: "p.md" },
    title: "P",
    ...over,
  }) as PageRecord;

describe("template tags in .md", () => {
  it("warns about a Liquid or Markdoc tag and a Liquid output, at their line", () => {
    expect(
      syntaxDiagnostics(
        entry('Intro.\n\n{% include note.html content="hi" %}\n', "md", {
          raw: '---\ntitle: Guide\n---\nIntro.\n\n{% include note.html content="hi" %}\n',
        }),
        "docs"
      )
    ).toStrictEqual([
      {
        code: "BLUME_TEMPLATE_TAG",
        column: 1,
        file: "/docs/guide.md",
        line: 6,
        message:
          '`{% include note.html content="hi" %}` is a Liquid or Markdoc tag, which Blume doesn\'t run, so the page shows it as written.',
        severity: "warning",
        suggestion:
          "Rewrite what it produced as Markdown or a Blume component, or remove it. To show it as text, put it in inline code.",
      },
    ]);
    const [output] = syntaxDiagnostics(
      entry("Hello {{ site.title }}.\n"),
      "docs"
    );
    expect(output).toMatchObject({
      column: 7,
      message:
        "`{{ site.title }}` is a Liquid output tag, which Blume doesn't fill in, so the page shows it as written.",
    });
    expect(output?.suggestion).toContain("`variables` in blume.config.ts");
  });

  it("finds tags in raw HTML, link destinations, and Markdoc closers", () => {
    expect(
      found(
        '{% callout %}\nBody.\n{% /callout %}\n\n[x]({{site.baseurl}}/a) <img src="{{ page.url | relative_url }}">\n'
      )
    ).toStrictEqual([
      { code: "BLUME_TEMPLATE_TAG", column: 1, line: 1 },
      { code: "BLUME_TEMPLATE_TAG", column: 1, line: 3 },
      { code: "BLUME_TEMPLATE_TAG", column: 5, line: 5 },
      { code: "BLUME_TEMPLATE_TAG", column: 35, line: 5 },
    ]);
  });

  it("leaves a Blume variable, code, comments, escapes, and .mdx alone", () => {
    const quiet = [
      "Version {{ version }} and {{api-url}}.\n",
      "```liquid\n{% if x %}{{ y.z }}{% endif %}\n```\n",
      "    {% indented code %}\n",
      "Inline `{% tag %}` and ``{{ a.b }}``.\n",
      "<!-- {% commented %}\n{{ out.put }} -->\n",
      `${String.raw`An escaped \{% tag %\} and \{{ a.b }}.`}\n`,
    ];
    for (const text of quiet) {
      expect(found(text)).toStrictEqual([]);
    }
    // `.mdx` fails to compile on the braces, with its own error.
    expect(found("{{ a.b }}\n", "mdx")).toStrictEqual([]);
  });
});

describe("wiki links", () => {
  const pages = [
    page({
      locale: "en",
      route: "/getting-started",
      source: { name: "docs", ref: "guides/Getting-Started.md" },
      title: "Setup",
    }),
    page({ locale: "fr", route: "/fr/home", title: "Home" }),
    page({ locale: "en", route: "/home", title: "Home" }),
  ];

  it("warns about a link to a page, with the Markdown link that replaces it", () => {
    const [diagnostic] = syntaxDiagnostics(
      entry("See [[Home]].\n"),
      "docs",
      indexPageNames(pages),
      "en"
    );
    expect(diagnostic).toMatchObject({
      code: "BLUME_WIKILINK_UNSUPPORTED",
      column: 5,
      line: 1,
      message:
        "`[[Home]]` is a wiki link, which Blume reads only in an Obsidian vault source, so the page shows it as written instead of linking to /home.",
      suggestion: "Rewrite it as a Markdown link: `[Home](/home)`.",
    });
  });

  it("matches a file name or title either side of the bar, and keeps a heading", () => {
    const suggestions = syntaxDiagnostics(
      entry(
        "[[Read this|getting started]], [[Getting Started|Read that]], and [[setup#First steps]].\n",
        "mdx"
      ),
      "docs",
      indexPageNames(pages),
      "fr"
    ).map((diagnostic) => diagnostic.suggestion);
    expect(suggestions).toStrictEqual([
      "Rewrite it as a Markdown link: `[Read this](/getting-started)`.",
      "Rewrite it as a Markdown link: `[Read that](/getting-started)`.",
      "Rewrite it as a Markdown link: `[setup#First steps](/getting-started#first-steps)`.",
    ]);
  });

  it("prefers the page in the linking entry's locale", () => {
    const [diagnostic] = syntaxDiagnostics(
      entry("[[Home]]\n"),
      "docs",
      indexPageNames(pages),
      "fr"
    );
    expect(diagnostic?.suggestion).toContain("(/fr/home)");
  });

  it("warns about a link with a bar that names no page", () => {
    const [diagnostic] = syntaxDiagnostics(
      entry("[[Old docs|Retired Page]]\n"),
      "docs"
    );
    expect(diagnostic).toMatchObject({
      message:
        "`[[Old docs|Retired Page]]` is a wiki link, which Blume reads only in an Obsidian vault source, so the page shows it as written.",
      suggestion:
        "Rewrite it as a Markdown link to the page, like `[Text](./page.md)`.",
    });
  });

  it("leaves bare names no page has, embeds, bracketed labels, and code alone", () => {
    const quiet = [
      "Every object has a [[Prototype]] slot, and [[:word:]] matches one.\n",
      "![[diagram.png]]\n",
      "[[Home]](/home) and [[Home]][ref] are links with a bracketed label.\n",
      "`[[Home]]`\n",
      "```\n[[Home]]\n```\n",
    ];
    for (const text of quiet) {
      expect(found(text, "md", pages)).toStrictEqual([]);
    }
  });
});

describe("Nuxt Content (MDC) syntax", () => {
  it("warns about a block component's opener and an inline component", () => {
    const text = [
      '::callout{icon="i-lucide-info"}',
      "Docus callout.",
      "::",
      "",
      'Inline :badge[New]{color="primary"}, :icon{name="x"}, and :kbd[K].',
    ].join("\n");
    expect(found(text)).toStrictEqual([
      { code: "BLUME_MDC_SYNTAX", column: 1, line: 1 },
      { code: "BLUME_MDC_SYNTAX", column: 8, line: 5 },
      { code: "BLUME_MDC_SYNTAX", column: 38, line: 5 },
      { code: "BLUME_MDC_SYNTAX", column: 59, line: 5 },
    ]);
    const [block, inline] = syntaxDiagnostics(entry(text, "mdx"), "docs");
    expect(block?.message).toBe(
      '`::callout{icon="i-lucide-info"}` opens a Nuxt Content (MDC) block component, which Blume doesn\'t render, so the page shows its `::` lines as text.'
    );
    expect(inline?.message).toBe(
      '`:badge[New]{color="primary"}` is an inline component in Nuxt Content (MDC) syntax, which Blume doesn\'t render, so the page shows it as written.'
    );
  });

  it("finds an indented block opener once", () => {
    expect(found("  ::card-group\n  :::card\n  :::\n  ::\n")).toStrictEqual([
      { code: "BLUME_MDC_SYNTAX", column: 3, line: 1 },
    ]);
    expect(found('::callout{icon="x"}\nA.\n::\n', "mdx")).toStrictEqual([
      { code: "BLUME_MDC_SYNTAX", column: 1, line: 1 },
    ]);
  });

  it("finds a block opener that shares its line with text", () => {
    // No parser reads this as a block, and in `.mdx` its props become a
    // JavaScript expression.
    expect(found('::callout{icon="x"} Text. ::\n', "mdx")).toStrictEqual([
      { code: "BLUME_MDC_SYNTAX", column: 1, line: 1 },
    ]);
  });

  it("leaves callouts, ratios, times, schemes, and code alone", () => {
    const quiet = [
      ":::tip\nA callout.\n:::\n",
      "A 16:9 frame at 10:30am, the og:image tag, and pets:read{x}.\n",
      "Call std::vector[0] or https://example.com/[x].\n",
      "`:badge[New]` and\n\n```\n::callout\n```\n",
    ];
    for (const text of quiet) {
      expect(found(text)).toStrictEqual([]);
    }
  });
});

describe("attribute lists in .mdx", () => {
  it("warns about a list after an image, a paragraph, and a heading", () => {
    const text = [
      '![A diagram](/x.png){ width="300" }',
      "",
      "A note. {: .note }",
      "",
      "## Title {#id .wide}",
      "",
      "{ loading=lazy align=left }",
    ].join("\n");
    expect(found(text, "mdx")).toStrictEqual([
      { code: "BLUME_MDX_ATTRIBUTE_LIST", column: 21, line: 1 },
      { code: "BLUME_MDX_ATTRIBUTE_LIST", column: 9, line: 3 },
      { code: "BLUME_MDX_ATTRIBUTE_LIST", column: 10, line: 5 },
      { code: "BLUME_MDX_ATTRIBUTE_LIST", column: 1, line: 7 },
    ]);
    const [diagnostic] = syntaxDiagnostics(entry(text, "mdx"), "docs");
    expect(diagnostic?.message).toBe(
      '`{ width="300" }` is an attribute list, which MDX reads as a JavaScript expression, so the page fails to build.'
    );
  });

  it("leaves heading anchors, directives, expressions, code, and .md alone", () => {
    const quiet = [
      // BLUME_MDX_CURLY_ANCHOR reports these.
      "## Title { #id }\n",
      "Setext title {: #id }\n===\n",
      ':::note{title="Heads up"}\nA.\n:::\n',
      '<Card style={{ color: "red" }} cols={2} title={meta.title} />\n',
      "Half is {0.5}, or {.5}.\n",
      'Write `{ width="300" }` or {/* { .note } */} or \\{ .x }.\n',
    ];
    for (const text of quiet) {
      expect(found(text, "mdx")).toStrictEqual([]);
    }
    // A directive's own attributes are MDC syntax, not an expression.
    expect(found(':badge[New]{color="primary"}\n', "mdx")).toStrictEqual([
      { code: "BLUME_MDC_SYNTAX", column: 1, line: 1 },
    ]);
  });

  it("leaves braces in math alone", () => {
    // MDX parses `$$…$$` before expressions, so `{i=1}` in a formula is
    // LaTeX, whether the math is a block, a quoted block, or inline.
    const quiet = [
      String.raw`$$
\sum_{i=1}^{n} x_i
$$
`,
      String.raw`> $$
> \sum_{i=1}^{n} x_i
> $$
`,
      String.raw`$$\sum_{i=1}^{n} x_i$$
`,
      String.raw`The sum $$\sum_{i=1}^{n} x_i$$ converges, as does $$$x_{k=0}$$$.
`,
    ];
    for (const text of quiet) {
      expect(found(text, "mdx")).toStrictEqual([]);
    }
    // An escaped `$` opens no math, and a run of another length doesn't
    // close it.
    const text = String.raw`A \$$ { a=1 } $$ and $$$ { x=0 } $$ then { b=2 }.
`;
    expect(found(text, "mdx")).toStrictEqual([
      { code: "BLUME_MDX_ATTRIBUTE_LIST", column: 7, line: 1 },
      { code: "BLUME_MDX_ATTRIBUTE_LIST", column: 42, line: 1 },
    ]);
  });
});

describe("attribute lists in .md", () => {
  it("warns about kramdown and attr_list lists, on their own line or after a block", () => {
    const text = [
      "A note.",
      "{: .note }",
      "",
      "{: #intro }",
      "",
      '![A diagram](/x.png){ width="300" }',
      "",
      "## Title { .wide }",
    ].join("\n");
    expect(found(text)).toStrictEqual([
      { code: "BLUME_MD_ATTRIBUTE_LIST", column: 1, line: 2 },
      { code: "BLUME_MD_ATTRIBUTE_LIST", column: 1, line: 4 },
      { code: "BLUME_MD_ATTRIBUTE_LIST", column: 21, line: 6 },
      { code: "BLUME_MD_ATTRIBUTE_LIST", column: 10, line: 8 },
    ]);
    expect(syntaxDiagnostics(entry(text), "docs")[0]).toMatchObject({
      message:
        "`{: .note }` is an attribute list, which Blume doesn't read, so the page shows it as written.",
      suggestion:
        'Remove it. To keep the attributes, write the element as HTML (`<img src="…" width="300">`), or pin a heading\'s anchor with `[#id]`. To show the braces as text, put them in inline code.',
    });
  });

  it("leaves heading anchors, variables, directives, and code alone", () => {
    const quiet = [
      // `{#id}` pins the anchor; BLUME_MD_CURLY_ANCHOR reports the others.
      "## Title {#id}\n\n## Other { #other }\n\n## Wide {: #wide .x }\n",
      "Setext title {: #id .x }\n===\n",
      "Version {{version}} and {{ size=3 }}.\n",
      ':::note{title="Heads up"}\nA.\n:::\n',
      'Write `{: .note }`.\n\n```md\n{ width="300" }\n```\n\n    {: .note }\n',
      "Half is {0.5}, or {.5}, and \\{: .note }.\n",
    ];
    for (const text of quiet) {
      expect(
        found(text).filter(({ code }) => code === "BLUME_MD_ATTRIBUTE_LIST")
      ).toStrictEqual([]);
    }
  });
});

describe("unclosed void elements in .mdx", () => {
  it("warns about an HTML void element that isn't self-closed", () => {
    const text = [
      'Before <img src="a.png" alt="a > b">.',
      "",
      "Line<br>break",
      "",
      "<img",
      '  src="c.png"',
      ">",
    ].join("\n");
    expect(found(text, "mdx")).toStrictEqual([
      { code: "BLUME_MDX_UNCLOSED_ELEMENT", column: 8, line: 1 },
      { code: "BLUME_MDX_UNCLOSED_ELEMENT", column: 5, line: 3 },
      { code: "BLUME_MDX_UNCLOSED_ELEMENT", column: 1, line: 5 },
    ]);
    const [diagnostic] = syntaxDiagnostics(entry(text, "mdx"), "docs");
    expect(diagnostic).toMatchObject({
      message:
        "`<img>` isn't closed. MDX reads HTML as JSX, where it needs `/>`: unclosed, it fails the page, or in an included file it takes in everything after it.",
      suggestion: "Close it: `<img … />`.",
    });
  });

  it("points at the partial the element was included from", () => {
    const [diagnostic] = syntaxDiagnostics(
      entry("<include>./_part.md</include>\n", "mdx", {
        expanded: {
          includes: ["/docs/_part.md"],
          origins: [
            { file: "/docs/_part.md", line: 1 },
            { file: "/docs/_part.md", line: 3 },
          ],
          text: 'Before.\n<img src="x.png" alt="x">\n',
        },
      }),
      "docs"
    );
    expect(diagnostic).toMatchObject({ file: "/docs/_part.md", line: 3 });
  });

  it("leaves closed elements, components, code, escapes, and .md alone", () => {
    const quiet = [
      '<img src="a.png" />\n<br/>\n<hr></hr>\n',
      '<Img src="a.png">x</Img>\n',
      "`<br>` and {/* <br> */}\n\n```html\n<br>\n```\n",
      "An escaped \\<br> tag.\n",
    ];
    for (const text of quiet) {
      expect(found(text, "mdx")).toStrictEqual([]);
    }
    expect(found('<img src="a.png">\n', "md")).toStrictEqual([]);
  });

  it("leaves a link destination in angle brackets alone", () => {
    // MDX reads `<img/a b.png>` after `](` or `]:` as a URL, not a tag.
    const text = [
      "![shot](<img/a b.png>) and [the list]( <br/notes.md>)",
      "",
      "[ref]: <hr/x.png>",
      "",
      "Then <br>.",
    ].join("\n");
    expect(found(text, "mdx")).toStrictEqual([
      { code: "BLUME_MDX_UNCLOSED_ELEMENT", column: 6, line: 5 },
    ]);
  });
});

describe("syntaxDiagnostics", () => {
  it("names a remote entry by its source and ref, below its front matter", () => {
    const [diagnostic] = syntaxDiagnostics(
      entry("{% raw %}\n", "md", { bodyLineOffset: 3, sourcePath: undefined }),
      "cms"
    );
    expect(diagnostic).toMatchObject({ file: "cms:guide.md", line: 4 });
  });

  it("lists findings in source order", () => {
    expect(
      found("[[A|B]] {% x %}\n:badge[x] {{ a.b }}\n").map(({ code }) => code)
    ).toStrictEqual([
      "BLUME_WIKILINK_UNSUPPORTED",
      "BLUME_TEMPLATE_TAG",
      "BLUME_MDC_SYNTAX",
      "BLUME_TEMPLATE_TAG",
    ]);
  });
});

describe("the project scan", () => {
  it("reports other tools' syntax with the page's other diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-syntax-scan-"));
    dirs.push(root);
    const home = join(root, "docs", "Home.md");
    const guide = join(root, "docs", "guide.md");
    await mkdir(dirname(home), { recursive: true });
    await writeFile(home, "# Home\n\nWelcome.\n");
    await writeFile(
      guide,
      "---\ntitle: Guide\n---\n\nBack to [[Home]].\n\n{% include note.html %}\n"
    );
    const project = await scanProject(root);
    const codes = new Set(["BLUME_TEMPLATE_TAG", "BLUME_WIKILINK_UNSUPPORTED"]);
    expect(
      project.diagnostics.filter((diagnostic) => codes.has(diagnostic.code))
    ).toMatchObject([
      {
        code: "BLUME_WIKILINK_UNSUPPORTED",
        file: guide,
        line: 5,
        suggestion: "Rewrite it as a Markdown link: `[Home](/Home)`.",
      },
      { code: "BLUME_TEMPLATE_TAG", file: guide, line: 7 },
    ]);
  });
});
