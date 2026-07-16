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
  it("keeps hrefs as routes (base applied at click time)", () => {
    expect(
      resolveSearchPopular([
        { href: "/guides/start", label: "Start" },
        { href: "https://example.com", label: "Blog" },
      ])
    ).toStrictEqual([
      { label: "Start", route: "/guides/start" },
      { label: "Blog", route: "https://example.com" },
    ]);
  });
});
