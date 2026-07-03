import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { extractTypeTable } from "../src/components/content/auto-type-table.ts";
import { fetchRepositoryInfo } from "../src/components/content/github-info.ts";
import {
  findBreadcrumbs,
  flattenPages,
  getPagination,
} from "../src/components/layout/nav-utils.ts";
import { createSearch } from "../src/components/layout/search/endpoint.ts";
import type { IndexedDocument } from "../src/components/layout/search/types.ts";
import {
  buildResult,
  escapeHtml,
  excerptFor,
  highlight,
  matchSnippet,
} from "../src/components/layout/search/types.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { NavNode, PageRecord } from "../src/core/types.ts";
import type { RssFeed } from "../src/deploy/rss.ts";
import { buildRssFeeds, renderRssFeed } from "../src/deploy/rss.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";

describe("extractTypeTable", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "blume-types-"));
    await writeFile(
      join(dir, "props.ts"),
      "export interface Props { id: string; label?: string }\n"
    );
  });

  afterAll(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("reads a named interface from a file resolved against the root", async () => {
    const rows = await extractTypeTable({
      name: "Props",
      path: "props.ts",
      root: dir,
    });
    expect(rows.map((row) => row.name).toSorted()).toStrictEqual([
      "id",
      "label",
    ]);
    expect(rows.find((row) => row.name === "label")?.required).toBe(false);
  });

  it("throws when neither a path nor inline source is given", async () => {
    await expect(extractTypeTable({ name: "Props" })).rejects.toThrow(
      /needs a `path` or inline `type`/u
    );
  });

  it("throws when the file cannot be read", async () => {
    await expect(
      extractTypeTable({ name: "Props", path: join(dir, "missing.ts") })
    ).rejects.toThrow(/Could not read/u);
  });

  it("falls back to the checker's type string for a method member", async () => {
    const rows = await extractTypeTable({
      name: "Api",
      source: "export interface Api { run(): number; label: string }",
    });
    const run = rows.find((row) => row.name === "run");
    expect(run?.type).toContain("number");
    expect(run?.required).toBe(true);
  });
});

describe("fetchRepositoryInfo", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a bearer token and dedupes repeated lookups via the cache", async () => {
    let calls = 0;
    const seen: { authorization?: string | null } = {};
    globalThis.fetch = ((_input: unknown, init: { headers: Headers }) => {
      calls += 1;
      seen.authorization = init.headers.get("Authorization");
      return Promise.resolve(
        Response.json({
          description: null,
          forks_count: 3,
          stargazers_count: 9,
        })
      );
    }) as unknown as typeof fetch;

    const options = {
      baseUrl: "https://gh.test",
      owner: "acme",
      repo: "tokened",
      token: "secret",
    };
    const first = await fetchRepositoryInfo(options);
    const second = await fetchRepositoryInfo(options);

    expect(seen.authorization).toBe("Bearer secret");
    expect(first).toEqual({ description: null, forks: 3, stars: 9 });
    // The second lookup resolves the cached promise to the same object.
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });
});

describe("flattenPages", () => {
  const nav: NavNode[] = [
    {
      children: [
        { kind: "page", label: "Landing page", pageId: "g", route: "/group" },
        {
          deprecated: true,
          kind: "page",
          label: "Old",
          pageId: "old",
          route: "/group/old",
        },
      ],
      kind: "group",
      label: "Group",
      route: "/group",
    },
  ];

  it("adds a group landing route, dedupes, and flags deprecated pages", () => {
    const flat = flattenPages(nav);
    // The group route is added first, so the duplicate child route is dropped.
    expect(flat.map((page) => page.route)).toStrictEqual([
      "/group",
      "/group/old",
    ]);
    expect(flat[0]?.label).toBe("Group");
    expect(flat[1]?.deprecated).toBe(true);
  });
});

describe("findBreadcrumbs", () => {
  const nav: NavNode[] = [
    {
      children: [
        { kind: "page", label: "Intro", pageId: "i", route: "/group/intro" },
      ],
      kind: "group",
      label: "Group",
      route: "/group",
    },
  ];

  it("returns the trail for a group's own landing route", () => {
    expect(findBreadcrumbs(nav, "/group")).toStrictEqual([
      { label: "Group", route: "/group" },
    ]);
  });

  it("returns the ancestor trail for a nested page", () => {
    expect(findBreadcrumbs(nav, "/group/intro")).toStrictEqual([
      { label: "Group", route: "/group" },
      { label: "Intro", route: "/group/intro" },
    ]);
  });

  it("returns an empty trail when no node matches", () => {
    expect(findBreadcrumbs(nav, "/missing")).toStrictEqual([]);
  });
});

describe("getPagination", () => {
  const flat = [
    { label: "A", route: "/a" },
    { label: "B", route: "/b" },
    { label: "C", route: "/c" },
  ];

  it("returns null neighbours when the route is absent", () => {
    expect(getPagination([], "/x")).toStrictEqual({ next: null, prev: null });
  });

  it("resolves the surrounding pages, clamping at the ends", () => {
    expect(getPagination(flat, "/b")).toStrictEqual({
      next: { label: "C", route: "/c" },
      prev: { label: "A", route: "/a" },
    });
    expect(getPagination(flat, "/a").prev).toBeNull();
    expect(getPagination(flat, "/c").next).toBeNull();
  });
});

describe("server-proxied search endpoint", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns an empty result when the endpoint responds non-ok", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("boom", { status: 500 })
      )) as unknown as typeof fetch;
    const result = await createSearch({ api: "/api/search" })("q");
    expect(result).toStrictEqual({ hits: [], sections: [] });
  });

  it("caps the server's hits at the search limit on success", async () => {
    const hits = Array.from({ length: 20 }, (_value, index) => ({
      excerpt: "e",
      title: `T${index}`,
      url: `/p${index}`,
    }));
    globalThis.fetch = (() =>
      Promise.resolve(Response.json(hits))) as unknown as typeof fetch;
    const result = await createSearch({ api: "/api/search" })("q");
    expect(result.hits).toHaveLength(12);
    expect(result.sections).toStrictEqual([]);
  });
});

describe("search text helpers", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;"
    );
  });

  it("returns escaped text unchanged when the query is empty", () => {
    expect(highlight("Tom & Jerry", "")).toBe("Tom &amp; Jerry");
  });

  it("wraps each query match in a <mark>", () => {
    expect(highlight("the brown fox", "brown")).toContain("<mark>brown</mark>");
  });

  it("never marks inside HTML entities produced by escaping", () => {
    // Matching used to run on the escaped text, so "amp" matched inside the
    // "&amp;" generated from "a & b" and corrupted the rendered excerpt.
    expect(highlight("a & b", "amp")).toBe("a &amp; b");
    expect(highlight("1 < 2", "lt")).toBe("1 &lt; 2");
    // Matches in the raw text still escape and mark correctly.
    expect(highlight("amp & volts", "amp")).toBe(
      "<mark>amp</mark> &amp; volts"
    );
  });

  it("returns a leading window and ellipsis for an empty query", () => {
    // An empty query yields no tokens, so matchIndex short-circuits to -1.
    const snippet = matchSnippet("a".repeat(50), "", 10);
    expect(snippet).toBe(`${"a".repeat(10)}…`);
  });

  it("returns the whole text when it is shorter than the radius", () => {
    expect(matchSnippet("short", "zzz", 100)).toBe("short");
  });

  it("centres the window on the first match", () => {
    const snippet = matchSnippet("the quick brown fox jumps", "brown", 12);
    expect(snippet).toContain("brown");
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("snippets around the query when the content matches", () => {
    expect(excerptFor("desc", "the quick brown fox", "brown")).toContain(
      "brown"
    );
  });

  it("falls back to the description when the query does not match", () => {
    expect(excerptFor("desc", "the quick brown fox", "zzz")).toBe("desc");
  });

  it("falls back to a truncated content slice without a description", () => {
    const excerpt = excerptFor("", "a".repeat(200));
    expect(excerpt).toHaveLength(141);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("buildResult", () => {
  const docs: IndexedDocument[] = [
    {
      content: "alpha body text",
      description: "first",
      route: "/a",
      section: "Guides",
      title: "Alpha",
    },
    {
      content: "beta body text",
      description: "second",
      route: "/b",
      section: "API",
      title: "Beta",
    },
    {
      content: "gamma body text",
      description: "third",
      route: "/c",
      title: "Loose",
    },
  ];

  it("counts sections across the pool and highlights every hit", () => {
    const result = buildResult(docs, "alpha");
    expect(result.sections).toStrictEqual([
      { count: 1, label: "Guides" },
      { count: 1, label: "API" },
    ]);
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0]?.title).toBe("<mark>Alpha</mark>");
  });

  it("filters to the active section while keeping the full counts", () => {
    const result = buildResult(docs, "body", "API");
    expect(result.sections).toHaveLength(2);
    expect(result.hits.map((hit) => hit.url)).toStrictEqual(["/b"]);
  });
});

const blogPage = (over: Partial<PageRecord>): PageRecord =>
  ({
    contentType: "blog",
    description: "desc",
    meta: pageMetaSchema.parse({}),
    route: "/blog/a",
    title: "A",
    ...over,
  }) as PageRecord;

const rssProject = (pages: PageRecord[]): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://x.test" },
      description: "D",
      title: "T",
    }),
    graph: { pages },
  }) as unknown as BlumeProject;

describe("buildRssFeeds — pages without a date", () => {
  it("includes a publishable page that declares no date", () => {
    const [feed] = buildRssFeeds(rssProject([blogPage({})]));
    expect(feed?.items.map((item) => item.title)).toStrictEqual(["A"]);
    expect(feed?.items[0]?.date).toBeUndefined();
  });

  it("renders an item with no pubDate when the page has no date", () => {
    const [feed] = buildRssFeeds(rssProject([blogPage({})]));
    const xml = renderRssFeed(feed as RssFeed);
    expect(xml).toContain("<title>A</title>");
    expect(xml).not.toContain("<pubDate>");
  });
});

describe("buildStructuredData — dateModified and locale", () => {
  it("emits dateModified and inLanguage for a deeper page", () => {
    const data = buildStructuredData({
      breadcrumbs: [],
      locale: "fr",
      modified: "2026-02-01",
      published: null,
      route: "/guide",
      siteName: "Docs",
      siteUrl: "https://x.test",
      title: "Guide",
    });
    const graph = (data?.["@graph"] ?? []) as Record<string, unknown>[];
    const article = graph.find((node) => node["@type"] === "TechArticle");
    expect(article?.dateModified).toBe("2026-02-01T00:00:00.000Z");
    expect(article?.inLanguage).toBe("fr");
    expect(article?.datePublished).toBeUndefined();
  });
});
