import { describe, expect, it } from "bun:test";

import {
  markdownVariantUrl,
  prefersMarkdown,
} from "../src/astro/markdown-negotiation.ts";

describe("prefersMarkdown", () => {
  it("is true for an explicit markdown request", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/x-markdown")).toBe(true);
  });

  it("is false for ordinary browser requests", () => {
    expect(prefersMarkdown("")).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(
      prefersMarkdown(
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      )
    ).toBe(false);
  });

  it("honours q-values when both types are listed", () => {
    expect(prefersMarkdown("text/markdown, text/html;q=0.9")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown;q=0.9")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.5, text/html;q=0.5")).toBe(true);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
  });
});

describe("markdownVariantUrl", () => {
  const routes = new Set(["/", "/guides/intro"]);

  it("maps a known content route to its .md variant", () => {
    expect(markdownVariantUrl("/guides/intro", routes)).toBe(
      "/guides/intro.md"
    );
    expect(markdownVariantUrl("/", routes)).toBe("/index.md");
    expect(markdownVariantUrl("/guides/intro/", routes)).toBe(
      "/guides/intro.md"
    );
  });

  it("preserves the query string", () => {
    expect(markdownVariantUrl("/guides/intro?x=1", routes)).toBe(
      "/guides/intro.md?x=1"
    );
  });

  it("ignores anything that is not a known content route", () => {
    expect(markdownVariantUrl("", routes)).toBeNull();
    // Landing pages, assets, internals, and the .md URL itself are not routes.
    expect(markdownVariantUrl("/guides/intro.md", routes)).toBeNull();
    expect(markdownVariantUrl("/_astro/chunk.js", routes)).toBeNull();
    expect(markdownVariantUrl("/favicon.ico", routes)).toBeNull();
    expect(markdownVariantUrl("/not-a-doc", routes)).toBeNull();
  });

  it("strips and re-adds a non-root base", () => {
    // The dev URL is base-prefixed; routes are not.
    expect(markdownVariantUrl("/docs/guides/intro", routes, "/docs")).toBe(
      "/docs/guides/intro.md"
    );
    expect(markdownVariantUrl("/docs", routes, "/docs")).toBe("/docs/index.md");
    // A trailing slash on the base is tolerated.
    expect(markdownVariantUrl("/docs/guides/intro", routes, "/docs/")).toBe(
      "/docs/guides/intro.md"
    );
    // A URL outside the base isn't a content route.
    expect(markdownVariantUrl("/guides/intro", routes, "/docs")).toBeNull();
  });
});
