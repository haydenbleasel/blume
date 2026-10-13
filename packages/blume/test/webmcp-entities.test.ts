import { describe, expect, it } from "bun:test";

import { buildWebMcpTools } from "../src/components/islands/webmcp.ts";
import { highlight } from "../src/components/layout/search/types.ts";
import type { SearchFn } from "../src/components/layout/search/types.ts";

/**
 * The search dialog's hits are HTML (`highlight` escapes the source text), but
 * a WebMCP agent reads text: the highlighting is dropped and the entities it
 * escaped decoded, so `Array<T> & Map` reaches the agent as written.
 */
describe("WebMCP search_docs text", () => {
  it("decodes the entities the highlighter escaped", async () => {
    const title = "Array<T> & Map";
    const excerpt = 'Use "Array<T>" when it\'s a list & a <map>.';
    const search: SearchFn = (query) =>
      Promise.resolve({
        hits: [
          {
            excerpt: highlight(excerpt, query),
            title: highlight(title, query),
            url: "/types",
          },
        ],
        sections: [],
      });
    const [tool] = buildWebMcpTools({
      base: "/",
      llms: false,
      loadSearch: () => Promise.resolve(search),
      search: true,
      skills: false,
    });
    const result = await tool?.execute({ query: "array" });
    expect(result?.content[0]?.text).toBe(`${title} — /types\n${excerpt}`);
  });
});
