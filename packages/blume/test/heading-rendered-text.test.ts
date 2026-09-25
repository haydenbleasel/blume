import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { validateLinks } from "../src/core/links.ts";
import { normalizeEntry, scanBody } from "../src/core/sources/normalize.ts";
import { obsidianSource } from "../src/core/sources/obsidian.ts";
import type { ContentGraph, PageRecord } from "../src/core/types.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";

/**
 * The slugs the renderer gives a document's headings, in order. The heading of
 * the footnotes section GFM appends (`footnote-label`) is the renderer's own,
 * not one the author wrote, so it is left out.
 */
const renderedSlugs = async (
  processor: ReturnType<typeof blumeMarkdownProcessor>,
  source: string
): Promise<string[]> => {
  const renderer = await processor.createRenderer({});
  const { metadata } = await renderer.render(source);
  return metadata.headings
    .map((heading: { slug: string }) => heading.slug)
    .filter((slug: string) => slug !== "footnote-label");
};

const scannedSlugs = (source: string): string[] =>
  scanBody(source).headings.map((heading) => heading.slug);

const texts = (source: string): string[] =>
  scanBody(source).headings.map((heading) => heading.text);

const pageFor = (text: string): PageRecord => {
  const [page] = normalizeEntry(
    { body: { format: "md", text }, data: {}, ref: "guide.md" },
    { defaultType: "doc", source: { name: "s", staged: false } }
  ).pages;
  if (!page) {
    throw new Error("expected a page");
  }
  return page;
};

// Headings whose Markdown source differs from their rendered text: links,
// emphasis, code spans, entities, raw HTML, images, reference links, smart
// punctuation, escapes, repeats, and pinned ids.
const HEADINGS = [
  "## See [the docs](/x)",
  "## An _important_ note",
  "## An *important* note",
  "## A **bold** move with `code()`",
  "## Tom &amp; Jerry &copy; &#169; &#xA9;",
  "## Entity &lt;tag&gt;",
  "## Image ![alt text](/img.png) here",
  "## ![logo](/logo.png) Leading image",
  "## Link [ref][r] text and shortcut [r]",
  "## ~~struck~~ and foo*bar*baz and snake_case_name",
  "## A \\*literal\\* star",
  "## Nested [**bold link**](/y)",
  '## A -- B and wait... it\'s "quoted"',
  "## See [the docs](/x) [#pinned]",
  "## See [the docs](/x)",
  "## Literal \\[toc]",
  "## Overview [toc]",
  "## Footnote-free [^missing] brackets",
];
const DEFINITIONS = "\n\n[r]: /ref\n";

describe("heading anchors match the renderer", () => {
  it("slugs each heading's rendered text in a .md page", async () => {
    const source = `${HEADINGS.join("\n\n")}${DEFINITIONS}`;
    const scanned = scannedSlugs(source);
    expect(scanned).toStrictEqual(
      await renderedSlugs(blumeMarkdownProcessor({}), source)
    );
    expect(scanned.slice(0, 3)).toStrictEqual([
      "see-the-docs",
      "an-important-note",
      "an-important-note-1",
    ]);
  });

  it("slugs raw HTML and JSX by their text in .md and .mdx pages", async () => {
    const md = [
      "## Hello <span>world</span>",
      "## a<br>b",
      "## Html comment <!-- c --> gone",
      "## Text <kbd>Ctrl</kbd>+<kbd>C</kbd>",
    ].join("\n\n");
    expect(scannedSlugs(md)).toStrictEqual(
      await renderedSlugs(blumeMarkdownProcessor({}), md)
    );
    const mdx = [
      "## Hello <span>world</span>",
      "## <Badge>New</Badge> Feature",
      "## a<br/>b",
    ].join("\n\n");
    expect(scannedSlugs(mdx)).toStrictEqual(
      await renderedSlugs(blumeMdxProcessor({}), mdx)
    );
  });

  it("slugs a multi-line setext heading with its line breaks", async () => {
    const source = [
      "Multi line",
      "setext *heading*",
      "===",
      "",
      "Hard\\",
      "break",
      "---",
    ].join("\n");
    const scanned = scannedSlugs(source);
    expect(scanned).toStrictEqual(
      await renderedSlugs(blumeMarkdownProcessor({}), source)
    );
    expect(scanned).toStrictEqual(["multi-linesetext-heading", "hardbreak"]);
    expect(texts(source)).toStrictEqual([
      "Multi line setext heading",
      "Hard break",
    ]);
  });

  it("reads underlined text the renderer parses as HTML as written", () => {
    // The renderer sees an HTML block here, not a heading; the scan's coarser
    // paragraph tracking still records one, read verbatim.
    expect(texts("<div>x</div>\n---")).toStrictEqual(["<div>x</div>"]);
  });

  it("reads a footnote reference as the number it renders", async () => {
    // GFM numbers footnotes by the body's first reference to each: `b` is
    // cited first, so it is 1 wherever it appears. A reference inside a
    // definition (`[^c]` in `b`'s) or a fence doesn't count, and labels match
    // case-insensitively.
    const source = [
      "Cited first[^b], then[^a].",
      "",
      "## Setup[^a] and[^b]",
      "",
      "## Twice[^b][^b]",
      "",
      "```",
      "## Fenced[^c]",
      "```",
      "",
      "Setext[^Note]",
      "---",
      "",
      "## Code[^c] [#pinned]",
      "",
      "## Last[^c]",
      "",
      "[^a]: A.",
      "[^b]: B, citing [^c].",
      "[^note]: Case-insensitive.",
      "[^c]: C.",
    ].join("\n");
    const scanned = scannedSlugs(source);
    expect(scanned).toStrictEqual(
      await renderedSlugs(blumeMarkdownProcessor({}), source)
    );
    expect(scanned).toStrictEqual([
      "setup2-and1",
      "twice11",
      "setext3",
      "pinned",
      "last4",
    ]);
    expect(texts(source)).toStrictEqual([
      "Setup2 and1",
      "Twice11",
      "Setext3",
      "Code4",
      "Last4",
    ]);
  });

  it("slugs a footnote reference in an .mdx page by its number", async () => {
    const source = "Intro[^b].\n\n## Setup[^a]\n\n[^a]: A.\n[^b]: B.\n";
    expect(scannedSlugs(source)).toStrictEqual(
      await renderedSlugs(blumeMdxProcessor({}), source)
    );
    expect(scannedSlugs(source)).toStrictEqual(["setup2"]);
  });

  it("keeps a reference the body never numbers as written", () => {
    // Inside an HTML block the renderer parses no footnote reference (nor a
    // heading); the scan, which still records the line, reads it literally.
    expect(texts("<div>\n## Inside[^z]\n</div>\n\n[^z]: Z.\n")).toStrictEqual([
      "Inside[^z]",
    ]);
  });
});

describe("heading text", () => {
  it("reduces inline Markdown to the text a reader sees", () => {
    expect(
      texts(
        [
          "## Using [Astro](https://astro.build) with **Blume**",
          "## Tom &amp; Jerry",
          "## Image ![alt](/i.png) here",
          "## Link [ref][r] text",
        ].join("\n\n") + DEFINITIONS
      )
    ).toStrictEqual([
      "Using Astro with Blume",
      "Tom & Jerry",
      "Image here",
      "Link ref text",
    ]);
  });

  it("keeps the author's quotes and dashes while the slug reads them smart", () => {
    const [heading] = scanBody('## It\'s a -- "test"...').headings;
    // The renderer's `It’s a – “test”…` slugs to `its-a--test`.
    expect(heading).toStrictEqual({
      depth: 2,
      slug: "its-a--test",
      text: 'It\'s a -- "test"...',
    });
  });

  it("titles an untitled page by its rendered first heading", () => {
    const page = pageFor(
      "# Using [Astro](https://astro.build) with **Blume**\n\nBody."
    );
    expect(page.title).toBe("Using Astro with Blume");
  });

  it("validates a link to a heading that contains a link", async () => {
    const page = pageFor(
      "# Title\n\n## See [the docs](/guide)\n\nJump to [it](#see-the-docs).\n"
    );
    const graph = {
      diagnostics: [],
      navigation: { featured: [], selectors: [], sidebar: [], tabs: [] },
      navigationByLocale: {},
      navigationByVersion: {},
      pages: [page],
      routes: new Map([[page.route, page.id]]),
    };
    // SAFETY: link validation reads only pages and routes; the empty nav
    // shells stand in for the graph fields it never touches.
    const diagnostics = await validateLinks(graph as ContentGraph, {
      publicDir: null,
    });
    expect(diagnostics).toStrictEqual([]);
  });
});

describe("wikilinks to a heading that holds a link", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("land on the section's rendered id", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-heading-text-"));
    dirs.push(root);
    await writeFile(join(root, "Links.md"), "Go to [[Notes#See Other]].\n");
    await writeFile(join(root, "Notes.md"), "## See [[Other]]\n\nText.\n");
    await writeFile(join(root, "Other.md"), "# Other\n");
    const source = obsidianSource(
      { name: "obsidian", vault: "." },
      { cacheDir: join(root, ".cache"), mode: "build", projectRoot: root }
    );
    const { entries } = await source.load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // The heading renders as `See <a>Other</a>`, so its id is `see-other`
    // whatever the link's target.
    expect(links?.body.text).toContain("(/notes#see-other)");
  });

  it("stay addressable when the heading links to a heading", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-heading-text-"));
    dirs.push(root);
    await writeFile(join(root, "Links.md"), "Go to [[Notes#See Section]].\n");
    // `Notes` indexes its anchors before `Other` (vault order), so the link
    // in its heading is first rewritten without `Other`'s anchor.
    await writeFile(join(root, "Notes.md"), "## See [[Other#Section]]\n");
    await writeFile(join(root, "Other.md"), "## Section\n");
    const source = obsidianSource(
      { name: "obsidian", vault: "." },
      { cacheDir: join(root, ".cache"), mode: "build", projectRoot: root }
    );
    const { diagnostics, entries } = await source.load();
    const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
    const notes = byRef.get("Notes.md");
    if (!notes) {
      throw new Error("expected the Notes entry");
    }
    // The staged heading ships with the anchor it links to...
    expect(notes.body.text).toBe("## See [Section](/other#section)");
    // ...and the wikilink lands on the id the page manifest records for it.
    expect(byRef.get("Links.md")?.body.text).toContain("(/notes#see-section)");
    const [page] = normalizeEntry(notes, {
      defaultType: "doc",
      source: { name: "obsidian", staged: true },
    }).pages;
    expect(page?.headings.map((heading) => heading.slug)).toStrictEqual([
      "see-section",
    ]);
    expect(diagnostics).toStrictEqual([]);
  });
});
