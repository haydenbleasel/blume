import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import { normalizeEntry, scanBody } from "../src/core/sources/normalize.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";

const slugs = (body: string): string[] =>
  scanBody(body).headings.map((heading) => heading.slug);

/** The heading slugs of a `.md` body, rendered as Astro renders it: trimmed. */
const renderedMdSlugs = async (body: string): Promise<string[]> => {
  const renderer = await blumeMarkdownProcessor({}).createRenderer({});
  const { metadata } = await renderer.render(body.trim());
  return metadata.headings.map((heading: { slug: string }) => heading.slug);
};

const GET_HEADINGS = /getHeadings\(\) \{ return (?<json>.*); \}/u;

/**
 * The heading slugs of an `.mdx` body, compiled as Astro compiles it: the page
 * handed over whole, its front matter blanked to spaces.
 */
const renderedMdxSlugs = async (body: string): Promise<string[]> => {
  const { createMdxRenderer } = blumeMdxProcessor({});
  if (!createMdxRenderer) {
    throw new Error("expected Sätteri's MDX renderer");
  }
  const renderer = await createMdxRenderer(
    {},
    { optimize: false, srcDir: pathToFileURL(`${tmpdir()}/`) }
  );
  const blanked = `${" ".repeat(3)}\n${" ".repeat(11)}\n${" ".repeat(3)}\n`;
  const { code } = await renderer.process(
    `${blanked}${body}`,
    join(tmpdir(), "blume-scan-front-matter.mdx"),
    {}
  );
  const headings: { slug: string }[] = JSON.parse(
    GET_HEADINGS.exec(code)?.groups?.json ?? "[]"
  );
  return headings.map((heading) => heading.slug);
};

// Bodies whose front matter was already stripped, each opening with a block a
// front matter parser would read: a blank line after the dashes, a setext
// look-alike, blank lines ahead of it and a `...` close, one never closed, and
// YAML-looking lines holding a `#` comment.
const BODIES = [
  ["---", "", "# First", "", "---", "", "## Second"].join("\n"),
  ["---", "Intro", "---", "", "## After"].join("\n"),
  ["", "", "---", "Intro", "...", "", "## After"].join("\n"),
  ["---", "", "## Unclosed"].join("\n"),
  ["---", "title: x", "# a yaml comment", "---", "# Real"].join("\n"),
];

describe("a stripped body that opens with a --- block", () => {
  // Neither renderer reads front matter out of a body a second time, so the
  // block is content — a thematic break, and whatever follows it — and the
  // scan reads it the same way.
  it("keeps the block in a .md body, as the renderer does", async () => {
    const scanned = BODIES.map((body) => slugs(body));
    expect(scanned).toStrictEqual(
      await Promise.all(BODIES.map(renderedMdSlugs))
    );
    expect(scanned[1]).toStrictEqual(["intro", "after"]);
  });

  it("keeps the block in an .mdx body, as the compiler does", async () => {
    const scanned = BODIES.map((body) => slugs(body));
    expect(scanned).toStrictEqual(
      await Promise.all(BODIES.map(renderedMdxSlugs))
    );
  });

  it("gives a page of either format the block's headings", () => {
    const headingsOf = (format: "md" | "mdx"): string[] => {
      const [page] = normalizeEntry(
        {
          body: { format, text: BODIES[1] ?? "" },
          data: { title: "Page" },
          ref: `page.${format}`,
        },
        { defaultType: "doc", source: { name: "s", staged: false } }
      ).pages;
      return page?.headings.map((heading) => heading.slug) ?? [];
    };
    expect(headingsOf("md")).toStrictEqual(["intro", "after"]);
    expect(headingsOf("mdx")).toStrictEqual(["intro", "after"]);
  });
});
