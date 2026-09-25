import { describe, expect, it } from "bun:test";

import { fromMarkdown } from "mdast-util-from-markdown";

import { isSafeHref } from "../src/core/safe-href.ts";
import {
  neutralizeUnsafeLinks,
  unsafeLinkSpans,
} from "../src/core/safe-links.ts";

describe("isSafeHref", () => {
  it("keeps web, mail, and phone links, and anything with no scheme", () => {
    for (const href of [
      "https://x.dev",
      "HTTP://x.dev",
      "mailto:a@b.c",
      "tel:+1555",
      "/guides/a:b",
      "./setup",
      "#intro",
      "",
    ]) {
      expect(isSafeHref(href)).toBe(true);
    }
  });

  it("refuses script-capable schemes however a browser would read them", () => {
    for (const href of [
      // oxlint-disable-next-line no-script-url -- the guard must refuse exactly this
      "javascript:alert(1)",
      // oxlint-disable-next-line no-script-url -- the guard must refuse exactly this
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "\u0001javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,hi",
      "vbscript:msgbox",
    ]) {
      expect(isSafeHref(href)).toBe(false);
    }
  });
});

describe("neutralizeUnsafeLinks", () => {
  it("reduces unsafe links to their label and drops unsafe definitions", () => {
    const markdown = [
      "See [docs](https://x.dev), [evil](javascript:alert(1)), <javascript:alert(2)>,",
      "[encoded](java&#115;cript:alert(3)), and [nested \\[x\\](javascript:y)](javascript:z).",
      "Code `[c](javascript:no)` and [rel](./x) stay.",
      "",
      "[ref]: javascript:alert(4)",
      "[ok]: https://ok.dev",
    ].join("\n");
    expect(neutralizeUnsafeLinks(markdown)).toBe(
      [
        // A reduced label is escaped as CMS text is, so its colon can't open
        // an MDX text directive.
        "See [docs](https://x.dev), evil, javascript\\:alert(2),",
        "encoded, and nested \\[x\\](javascript\\:y).",
        "Code `[c](javascript:no)` and [rel](./x) stay.",
        "",
        "",
        "[ok]: https://ok.dev",
      ].join("\n")
    );
  });

  it("returns Markdown with no unsafe link unchanged", () => {
    const markdown = "Just [a link](https://x.dev) and <b>html</b>.";
    expect(neutralizeUnsafeLinks(markdown)).toBe(markdown);
  });
});

describe("unsafeLinkSpans", () => {
  it("reports each unsafe link once, in source order", () => {
    const text = "[a](javascript:1) then [b](https://x.dev) then [c](data:x)";
    expect(unsafeLinkSpans(fromMarkdown(text))).toStrictEqual([
      { end: 17, start: 0, text: "a" },
      { end: 58, start: 47, text: "c" },
    ]);
  });
});
