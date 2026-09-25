import { describe, expect, it } from "bun:test";

import { isSafeHref } from "../src/core/safe-href.ts";
import { neutralizeUnsafeLinks } from "../src/core/safe-links.ts";
import type { JsonObject } from "../src/core/sources/json.ts";
import {
  destination,
  image,
  linkParts,
  renderInline,
} from "../src/core/sources/lower.ts";
import { portableTextToMarkdown } from "../src/core/sources/portable-text.ts";
import { documentEntry } from "../src/core/sources/remote.ts";

/** A link over a plain label, as a lowerer renders one. */
const renderLink = (label: string, href?: string): string =>
  renderInline(linkParts([{ marks: {}, text: label }], href));

describe("isSafeHref: Markdown decoding", () => {
  it("refuses a scheme spelled with escapes or character references", () => {
    for (const href of [
      "java&#115;cript:alert(1)",
      "java&#x73;cript:alert(1)",
      "java&#X73;cript:alert(1)",
      "javascript&colon;alert(1)",
      String.raw`javascript\:alert(1)`,
      "java&Tab;script:alert(1)",
      "java&NewLine;script:alert(1)",
      "&#1;javascript:alert(1)",
      "&#32;javascript:alert(1)",
      "&#106;&#97;&#118;&#97;script:alert(1)",
    ]) {
      expect(isSafeHref(href)).toBe(false);
    }
  });

  it("reads the named references that can spell a scheme", () => {
    // `&fjlig;`, `&plus;`, and `&period;` decode to scheme characters.
    expect(isSafeHref("&fjlig;x:y")).toBe(false);
    expect(isSafeHref("a&plus;b:c")).toBe(false);
    expect(isSafeHref("a&period;b:c")).toBe(false);
    // Any other named reference can't change the scheme a browser reads.
    expect(isSafeHref("a&amp;b:c")).toBe(true);
  });

  it("keeps an escaped reference and invalid code points literal", () => {
    // `\&` is a literal ampersand, so `&#115;` is never decoded after it.
    expect(isSafeHref(String.raw`java\&#115;cript:x`)).toBe(true);
    // NUL, surrogates, and out-of-range references become U+FFFD, which no
    // scheme contains.
    for (const href of ["&#0;x:y", "&#xD800;x:y", "&#x110000;x:y"]) {
      expect(isSafeHref(href)).toBe(true);
    }
    expect(isSafeHref("https://x.dev/?a=1&#38;b=2")).toBe(true);
  });
});

describe("renderLink: destinations", () => {
  it("renders a link whose scheme hides behind an escape as its label", () => {
    expect(renderLink("x", "java&#115;cript:alert(1)")).toBe("x");
    expect(renderLink("x", "javascript&colon;alert(1)")).toBe("x");
    expect(renderLink("x", String.raw`javascript\:alert(1)`)).toBe("x");
  });

  it("keeps a destination from closing its brackets and opening a second link", () => {
    const href = "https://a.example/ >)[y](javascript:alert(1)//";
    expect(renderLink("x", href)).toBe(
      String.raw`[x](<https://a.example/ \>)[y](javascript:alert(1)//>)`
    );
  });

  it("escapes what Markdown would decode, so the href is the URL as given", () => {
    expect(destination("https://x.dev/?a=&amp;b&c=1")).toBe(
      String.raw`https://x.dev/?a=\&amp;b&c=1`
    );
    expect(destination(String.raw`https://x.dev/a\b`)).toBe(
      String.raw`https://x.dev/a\\b`
    );
    expect(destination("https://x.dev/<b>")).toBe(
      String.raw`https://x.dev/\<b\>`
    );
    expect(destination("https://x.dev/a\u0001b")).toBe(
      "<https://x.dev/a\u0001b>"
    );
    // The URL parser drops tabs and line breaks; a destination can't hold one.
    expect(destination("https://x.dev/a\tb\nc\r")).toBe("https://x.dev/abc");
    expect(image("alt", "https://x.dev/i (1).png")).toBe(
      "![alt](<https://x.dev/i (1).png>)"
    );
  });
});

describe("neutralizeUnsafeLinks: GitHub-flavored input", () => {
  it("reduces an unsafe link inside a footnote definition to its label", () => {
    const markdown = "Hi[^1]\n\n[^1]: [evil](javascript:alert(1))\n";
    expect(neutralizeUnsafeLinks(markdown)).toBe("Hi[^1]\n\n[^1]: evil\n");
  });

  it("reduces an unsafe link inside a table cell", () => {
    const markdown = "| a |\n| - |\n| [evil](javascript:alert(1)) |\n";
    expect(neutralizeUnsafeLinks(markdown)).toBe("| a |\n| - |\n| evil |\n");
  });
});

describe("documentEntry: Markdown string bodies", () => {
  const fields = {
    body: "body",
    description: "description",
    lastModified: "updatedAt",
    slug: "slug",
    title: "title",
  };

  it("keeps only the label of an unsafe link in a CMS Markdown field", () => {
    const doc: JsonObject = {
      body: "See [docs](https://x.dev) and [evil](javascript:alert(1)).\n\n[ref]: javascript:alert(2)",
      slug: "guide",
    };
    const entry = documentEntry(doc, fields, "1", () => "");
    expect(entry.body.format).toBe("md");
    expect(entry.body.text).toBe("See [docs](https://x.dev) and evil.\n\n\n");
  });
});

/** A Portable Text block whose one span links to `href`. */
const block = (href: string) => ({
  _type: "block",
  children: [{ _type: "span", marks: ["l"], text: "click" }],
  markDefs: [{ _key: "l", _type: "link", href }],
  style: "normal",
});

describe("portableTextToMarkdown: links", () => {
  it("drops an unsafe link and escapes a safe destination", () => {
    // oxlint-disable-next-line no-script-url -- the link must be refused
    expect(portableTextToMarkdown([block("javascript:alert(1)")])).toBe(
      "click\n"
    );
    expect(portableTextToMarkdown([block("https://x.dev/a b")])).toBe(
      "[click](<https://x.dev/a b>)\n"
    );
  });

  it("uses the last link a span carries, and ignores unknown marks", () => {
    const md = portableTextToMarkdown([
      {
        _type: "block",
        children: [
          { _type: "span", marks: ["a", "underline", "b"], text: "go" },
        ],
        markDefs: [
          { _key: "a", _type: "link", href: "https://a.dev" },
          { _key: "b", _type: "link", href: "https://b.dev" },
        ],
        style: "normal",
      },
    ]);
    expect(md).toBe("[go](https://b.dev)\n");
  });
});
