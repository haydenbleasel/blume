import { describe, expect, it } from "bun:test";

import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";

/** Render a page body through a Blume processor and return its HTML. */
const render = async (
  processor: ReturnType<typeof blumeMdxProcessor>,
  source: string
): Promise<string> => {
  const renderer = await processor.createRenderer({});
  const { code } = await renderer.render(source);
  return code.trim();
};

describe("a page body that opens with a `---` rule", () => {
  // Astro strips the page's front matter before its body reaches the
  // renderer, so a body's own `---` lines are rules, never front matter.
  const body = "---\n\ntext\n\n---\n\nmore\n";

  it("renders every rule and paragraph in .md and .mdx", async () => {
    const pages = await Promise.all([
      render(blumeMarkdownProcessor({}), body),
      render(blumeMdxProcessor({}), body),
    ]);
    for (const html of pages) {
      expect(html).toBe("<hr>\n<p>text</p>\n<hr>\n<p>more</p>");
    }
  });
});
