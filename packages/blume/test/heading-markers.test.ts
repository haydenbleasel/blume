import { describe, expect, it } from "bun:test";

import GithubSlugger from "github-slugger";

import {
  occupySlug,
  parseHeadingMarkers,
} from "../src/core/heading-markers.ts";

describe("occupySlug", () => {
  it("makes a later colliding auto-slug disambiguate", () => {
    const slugger = new GithubSlugger();
    occupySlug(slugger, "setup");
    expect(slugger.slug("Setup")).toBe("setup-1");
  });

  it("leaves an already-taken id untouched", () => {
    const slugger = new GithubSlugger();
    expect(slugger.slug("Setup")).toBe("setup");
    occupySlug(slugger, "setup");
    expect(slugger.slug("Setup")).toBe("setup-1");
  });
});

describe("parseHeadingMarkers", () => {
  it("returns text unchanged when there are no markers", () => {
    expect(parseHeadingMarkers("Getting Started")).toStrictEqual({
      id: undefined,
      text: "Getting Started",
      toc: undefined,
    });
  });

  it("splits a trailing [#id] off and keeps it verbatim", () => {
    expect(parseHeadingMarkers("Getting Started [#setup]")).toStrictEqual({
      id: "setup",
      text: "Getting Started",
      toc: undefined,
    });
  });

  it("keeps a custom id's casing (never re-slugged)", () => {
    expect(parseHeadingMarkers("Install [#My-Anchor]").id).toBe("My-Anchor");
  });

  it("parses [!toc] as hide and [toc] as only", () => {
    expect(parseHeadingMarkers("Internals [!toc]")).toStrictEqual({
      id: undefined,
      text: "Internals",
      toc: "hide",
    });
    expect(parseHeadingMarkers("Examples [toc]")).toStrictEqual({
      id: undefined,
      text: "Examples",
      toc: "only",
    });
  });

  it("chains markers in any order", () => {
    expect(parseHeadingMarkers("Heading [toc] [#my-id]")).toStrictEqual({
      id: "my-id",
      text: "Heading",
      toc: "only",
    });
    expect(parseHeadingMarkers("Heading [#my-id] [!toc]")).toStrictEqual({
      id: "my-id",
      text: "Heading",
      toc: "hide",
    });
  });

  it("lets the rightmost occurrence of a repeated marker kind win", () => {
    expect(parseHeadingMarkers("Heading [#first] [#second]").id).toBe("second");
    expect(parseHeadingMarkers("Heading [toc] [!toc]").toc).toBe("hide");
  });

  it("matches a marker with no space before it", () => {
    expect(parseHeadingMarkers("Heading[#tight]")).toStrictEqual({
      id: "tight",
      text: "Heading",
      toc: undefined,
    });
  });

  it("reduces a marker-only heading to empty text", () => {
    expect(parseHeadingMarkers("[#only]")).toStrictEqual({
      id: "only",
      text: "",
      toc: undefined,
    });
  });

  it("leaves mid-text brackets alone — only trailing markers count", () => {
    expect(parseHeadingMarkers("The [#id] syntax explained")).toStrictEqual({
      id: undefined,
      text: "The [#id] syntax explained",
      toc: undefined,
    });
    // Literal bracketed prose at the end is not a marker shape.
    expect(parseHeadingMarkers("Options [a, b]").text).toBe("Options [a, b]");
  });

  it("rejects ids containing whitespace or a closing bracket", () => {
    expect(parseHeadingMarkers("Heading [#two words]").id).toBeUndefined();
    expect(parseHeadingMarkers("Heading [#]").id).toBeUndefined();
  });

  it("stops stripping at the first non-marker from the right", () => {
    // `[toc]` is trailing, but the `[#id]` before prose is not — it stays.
    expect(parseHeadingMarkers("A [#id] B [toc]")).toStrictEqual({
      id: undefined,
      text: "A [#id] B",
      toc: "only",
    });
  });
});
