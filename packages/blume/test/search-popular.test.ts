import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { resolveSearchPopular } from "../src/search/popular.ts";

describe("search.popular config", () => {
  it("defaults to an empty list", () => {
    expect(blumeConfigSchema.parse({}).search.popular).toStrictEqual([]);
  });

  it("parses curated links", () => {
    const config = blumeConfigSchema.parse({
      search: {
        popular: [
          { href: "/guides/start", label: "Getting started" },
          { href: "https://example.com", label: "Blog" },
        ],
      },
    });
    expect(config.search.popular).toStrictEqual([
      { href: "/guides/start", label: "Getting started" },
      { href: "https://example.com", label: "Blog" },
    ]);
  });

  it("rejects entries missing href or label", () => {
    expect(
      blumeConfigSchema.safeParse({
        search: { popular: [{ label: "No href" }] },
      }).success
    ).toBe(false);
    expect(
      blumeConfigSchema.safeParse({
        search: { popular: [{ extra: true, href: "/x", label: "X" }] },
      }).success
    ).toBe(false);
  });
});

describe("resolveSearchPopular", () => {
  // `deployment.base` is never applied here — `prefixBase` adds it in the Search
  // island at click time, so a resolved route must stay deploy-base-less.
  it("keeps hrefs as routes when no basePath is set", () => {
    expect(
      resolveSearchPopular(
        [
          { href: "/guides/start", label: "Start" },
          { href: "https://example.com", label: "Blog" },
        ],
        ""
      )
    ).toStrictEqual([
      { label: "Start", route: "/guides/start" },
      { label: "Blog", route: "https://example.com" },
    ]);
  });

  it("applies basePath to internal hrefs only", () => {
    expect(
      resolveSearchPopular(
        [
          { href: "/guides/start", label: "Start" },
          { href: "/", label: "Home" },
          { href: "https://example.com", label: "Blog" },
          { href: "//cdn.example.com/x", label: "Protocol relative" },
        ],
        "/docs"
      )
    ).toStrictEqual([
      { label: "Start", route: "/docs/guides/start" },
      { label: "Home", route: "/docs" },
      { label: "Blog", route: "https://example.com" },
      { label: "Protocol relative", route: "//cdn.example.com/x" },
    ]);
  });

  it("does not double-prefix a hand-written basePath", () => {
    expect(
      resolveSearchPopular(
        [{ href: "/docs/guides/start", label: "Start" }],
        "/docs"
      )
    ).toStrictEqual([{ label: "Start", route: "/docs/guides/start" }]);
  });
});
