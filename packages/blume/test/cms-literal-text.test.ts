import { afterAll, describe, expect, it } from "bun:test";

import { join } from "pathe";

import {
  codeSpan,
  escapeMarkdownText,
  guardBlockStart,
  headingPrefix,
  linkParts,
  renderInline,
} from "../src/core/sources/lower.ts";
import type { InlineMarks } from "../src/core/sources/lower.ts";
import { notionSource } from "../src/core/sources/notion.ts";
import type { NotionClientLike } from "../src/core/sources/notion.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";
import { cleanupTempDirs, ctxFor, tempDir } from "./cms-fixtures.ts";

afterAll(cleanupTempDirs);

/** Render lowered text through a Blume processor and return its HTML. */
const render = async (
  processor: ReturnType<typeof blumeMdxProcessor>,
  source: string
): Promise<string> => {
  const renderer = await processor.createRenderer({});
  const { code } = await renderer.render(source);
  return code;
};

const strike = { strike: true };

/** One text run as a lowerer renders it. */
const renderRun = (text: string, marks: InlineMarks): string =>
  renderInline([{ marks, text }]);

/** A link over a plain label, as a lowerer renders one. */
const renderLink = (label: string, href?: string): string =>
  renderInline(linkParts([{ marks: {}, text: label }], href));

describe("CMS text that reads as Blume syntax", () => {
  it("escapes `^`, `$`, and a directive colon", () => {
    expect(escapeMarkdownText("2^10 costs $$5 at 10:30am")).toBe(
      String.raw`2\^10 costs \$\$5 at 10\:30am`
    );
  });

  it("renders superscript, math, and directive lookalikes literally", async () => {
    const text = guardBlockStart(
      escapeMarkdownText(
        "2^10 and 2^20 cost $$5 and $$6 with the pets:read scope and og:image"
      )
    );
    const pages = await Promise.all([
      render(blumeMdxProcessor({}), text),
      render(blumeMarkdownProcessor({}), text),
    ]);
    for (const html of pages) {
      expect(html).toContain(
        "2^10 and 2^20 cost $$5 and $$6 with the pets:read scope and og:image"
      );
      expect(html).not.toContain("<sup>");
    }
  });

  it("keeps a bare URL's port unescaped so it still autolinks", async () => {
    const text = escapeMarkdownText(
      "Open http://localhost:3000 or www.example.com:8080/x"
    );
    expect(text).toBe("Open http://localhost:3000 or www.example.com:8080/x");
    const html = await render(blumeMdxProcessor({}), text);
    expect(html).toContain('href="http://localhost:3000"');
    expect(html).toContain('href="http://www.example.com:8080/x"');
  });
});

describe("adjacent struck runs", () => {
  it("merge into one strikethrough instead of printing `~~~~`", async () => {
    const text = guardBlockStart(
      [
        renderRun("one", strike),
        renderRun("two", { bold: true, strike: true }),
        renderRun("three", strike),
      ].join("")
    );
    expect(text).toBe("~~one**two**three~~");
    const html = await render(blumeMdxProcessor({}), text);
    expect(html).toContain("<del>one<strong>two</strong>three</del>");
  });

  it("merge across an escaped tilde or backslash at the seam", () => {
    expect(
      guardBlockStart(
        `${renderRun("a~", strike) + renderRun("b\\", strike)}~~c~~`
      )
    ).toBe(String.raw`~~a\~b\\c~~`);
  });

  it("leave code spans and link destinations as written", () => {
    const text = guardBlockStart(
      [
        codeSpan("x~~~~y"),
        renderLink("see", "https://x.dev/~~~~"),
        renderLink("docs", "https://x.dev/a b"),
      ].join(" ")
    );
    expect(text).toBe(
      "`x~~~~y` [see](https://x.dev/~~~~) [docs](<https://x.dev/a b>)"
    );
  });
});

describe("a heading that ends in ` #`", () => {
  it("keeps the `#` instead of reading it as a closing sequence", async () => {
    const heading = `${headingPrefix(2)}${guardBlockStart(
      renderRun("Pricing #", {})
    )}`;
    expect(heading).toBe(String.raw`## Pricing \#`);
    const html = await render(blumeMdxProcessor({}), heading);
    expect(html).toContain("Pricing #</a>");
  });

  it("leaves a `#` that isn't a trailing run alone", () => {
    expect(guardBlockStart("C# and F#")).toBe("C# and F#");
    expect(guardBlockStart("Issue #42")).toBe("Issue #42");
  });
});

/** A Notion rich-text run with no annotations. */
const rich = (plainText: string) => ({ plain_text: plainText });

type PageList = Awaited<
  ReturnType<NotionClientLike["dataSources"]["query"]>
>["results"];

describe("notionSource titles and video URLs", () => {
  const pages: PageList = [
    {
      id: "ci",
      last_edited_time: "2024-08-01T00:00:00Z",
      properties: {
        Name: { title: [rich("CI/CD Setup")], type: "title" },
      },
    },
    {
      id: "guide",
      last_edited_time: "2024-08-01T00:00:00Z",
      properties: {
        Name: { title: [rich("Setup Guide")], type: "title" },
        Slug: { rich_text: [rich("guides/setup")], type: "rich_text" },
      },
    },
  ];

  const WATCH_URL = 'https://www.youtube.com/watch?v=uy6K0h132-c&t="1"';
  const PAGE_URL = 'https://cdn.example.com/watch?q="x"\\y';

  const blocks = new Map([
    [
      "ci",
      [
        {
          id: "yt",
          type: "video",
          video: { external: { url: WATCH_URL } },
        },
        {
          id: "clip",
          type: "video",
          video: { external: { url: PAGE_URL } },
        },
      ],
    ],
  ]);

  const client: NotionClientLike = {
    blocks: {
      children: {
        list: ({ block_id }: { block_id: string }) =>
          Promise.resolve({
            has_more: false,
            next_cursor: null,
            results: blocks.get(block_id) ?? [],
          }),
      },
    },
    dataSources: {
      query: () =>
        Promise.resolve({ has_more: false, next_cursor: null, results: pages }),
    },
    databases: {
      retrieve: () =>
        Promise.resolve({ data_sources: [{ id: "ds1", name: "Handbook" }] }),
    },
  };

  // The media URL answers with a web page, so it stays remote and its `src`
  // shows exactly how the URL was written into the MDX.
  const fetchImpl: typeof fetch = Object.assign(
    () =>
      Promise.resolve(
        new Response("<!doctype html>", {
          headers: { "content-type": "text/html" },
        })
      ),
    fetch
  );

  const load = async () => {
    const dir = await tempDir("notion-literals");
    const source = notionSource(
      { client, database: "db1", fetchImpl, name: "handbook" },
      ctxFor(join(dir, "cache"), {
        assetsBaseUrl: "/blume-assets/handbook",
        assetsDir: join(dir, "assets"),
      })
    );
    const { entries } = await source.load();
    return entries;
  };

  it("slugs a title as one segment, and a Slug property as a path", async () => {
    const entries = await load();
    const refs = entries.map((entry) => entry.ref);
    expect(refs).toStrictEqual(["ci-cd-setup.mdx", "guides/setup.mdx"]);
  });

  it("writes a video URL the MDX reads back exactly", async () => {
    const [entry] = await load();
    const body = entry?.body.text ?? "";
    expect(body).toContain(`<YouTube url={${JSON.stringify(WATCH_URL)}} />`);
    expect(body).toContain(
      String.raw`<video controls src="https://cdn.example.com/watch?q=%22x%22\y" />`
    );
  });
});
