import { describe, expect, it } from "bun:test";

import matter from "../src/core/frontmatter.ts";

// Astro's content layer strips a leading `---` … `---` block as front matter
// whenever a closing `---` follows, whatever the first line after the fence.
// These documents are read the way Astro reads them.
describe("front matter detection matches Astro", () => {
  it("reads a block that opens with a blank line as front matter", () => {
    const parsed = matter(
      "---\n\ntitle: Draft\ndraft: true\nslug: elsewhere\nhidden: true\n---\n\nBody.\n"
    );
    expect(parsed.data).toStrictEqual({
      draft: true,
      hidden: true,
      slug: "elsewhere",
      title: "Draft",
    });
    expect(parsed.content).toBe("\nBody.\n");
  });

  it("reads a block that loads to a scalar as empty data, like Astro", () => {
    // Prose between two dividers still parses as a YAML block; Astro keeps
    // no data from it (a scalar is no mapping) and strips it from the page.
    const parsed = matter("---\n\n# Heading\n\ntext\n\n---\n\nMore.\n");
    expect(parsed.data).toStrictEqual({});
    expect(parsed.content).toBe("\nMore.\n");
    expect(matter("---\ntitle\n---\nBody.\n").data).toStrictEqual({});
  });

  it("still reads a leading divider with no closing fence as content", () => {
    const divider = "---\n\n## Section\n\n> Note\n";
    expect(matter(divider).content).toBe(divider);
  });
});
