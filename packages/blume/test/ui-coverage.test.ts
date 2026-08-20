import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  excerptFor,
  highlight,
  matchSnippet,
  sanitizeExcerpt,
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
    let seenAuthorization: string | null | undefined;
    // SAFETY: the stub implements the one call fetchRepositoryInfo makes;
    // fetch's extra properties (preconnect) are never touched.
    globalThis.fetch = ((_input, init) => {
      calls += 1;
      seenAuthorization = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        Response.json({
          description: null,
          forks_count: 3,
          stargazers_count: 9,
        })
      );
    }) as typeof fetch;

    const options = {
      baseUrl: "https://gh.test",
      owner: "acme",
      repo: "tokened",
      token: "secret",
    };
    const first = await fetchRepositoryInfo(options);
    const second = await fetchRepositoryInfo(options);

    expect(seenAuthorization).toBe("Bearer secret");
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
      display: "flat",
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
      display: "flat",
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

  it("returns null neighbors when the route is absent", () => {
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
    // SAFETY: the stub covers the single search request; fetch's extra
    // properties (preconnect) are never touched.
    globalThis.fetch = ((_input) =>
      Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch;
    const result = await createSearch({ api: "/api/search" })("q");
    expect(result).toStrictEqual({ hits: [], sections: [] });
  });

  it("caps the server's hits at the search limit on success", async () => {
    const hits = Array.from({ length: 20 }, (_value, index) => ({
      excerpt: "e",
      title: `T${index}`,
      url: `/p${index}`,
    }));
    // SAFETY: the stub covers the single search request; fetch's extra
    // properties (preconnect) are never touched.
    globalThis.fetch = ((_input) =>
      Promise.resolve(Response.json(hits))) as typeof fetch;
    const result = await createSearch({ api: "/api/search" })("q");
    expect(result.hits).toHaveLength(12);
    expect(result.sections).toStrictEqual([]);
  });

  it("escapes server-derived hit text and marks the query matches", async () => {
    // The dialog injects title/excerpt as HTML, so markup returned by the
    // service must render literally rather than execute.
    // SAFETY: the stub covers the single search request; fetch's extra
    // properties (preconnect) are never touched.
    globalThis.fetch = ((_input) =>
      Promise.resolve(
        Response.json([
          {
            excerpt: 'needle <img src=x onerror="x">',
            title: "<b>needle</b>",
            url: "/x",
          },
        ])
      )) as typeof fetch;
    const result = await createSearch({ api: "/api/search" })("needle");
    expect(result.hits[0]?.title).toBe(
      "&lt;b&gt;<mark>needle</mark>&lt;/b&gt;"
    );
    expect(result.hits[0]?.excerpt).toBe(
      "<mark>needle</mark> &lt;img src=x onerror=&quot;x&quot;&gt;"
    );
  });
});

describe("search text helpers", () => {
  it("escapes every HTML-significant character in highlighted output", () => {
    // Escaping is html-escaper's; this pins that highlight() routes every
    // segment through it, complete five-entity table included.
    expect(highlight(`<a href="x">'&`, "")).toBe(
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

  it("centers the window on the first match", () => {
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

  it("adds no ellipsis when the content fits the fallback slice", () => {
    expect(excerptFor("", "short text")).toBe("short text");
  });

  it("returns an empty excerpt for empty content", () => {
    expect(excerptFor("", "")).toBe("");
  });

  it("keeps bare <mark> highlighting in a remote excerpt", () => {
    expect(sanitizeExcerpt("a <mark>hit</mark> here")).toBe(
      "a <mark>hit</mark> here"
    );
    // Pagefind may emit uppercase-free tags only, but the guard is
    // case-insensitive either way.
    expect(sanitizeExcerpt("<MARK>hit</MARK>")).toBe("<MARK>hit</MARK>");
  });

  it("strips every non-mark tag from a remote excerpt", () => {
    expect(sanitizeExcerpt('x <img src=1 onerror="a()"> y')).toBe("x  y");
    expect(sanitizeExcerpt("<script>alert(1)</script>")).toBe("alert(1)");
    // Attributes make even a mark untrusted.
    expect(sanitizeExcerpt('<mark onmouseover="a()">hi</mark>')).toBe(
      "hi</mark>"
    );
  });

  it("drops an unterminated trailing tag", () => {
    expect(sanitizeExcerpt("clipped <img src=")).toBe("clipped ");
  });

  it("escapes stray brackets so only mark tags parse as markup", () => {
    // `&lt;` renders identically to `<` via innerHTML but can't open a tag.
    expect(sanitizeExcerpt("1 < 2 &amp; 3 > 2")).toBe("1 &lt; 2 &amp; 3 > 2");
  });

  it("defuses comment openers that would swallow the excerpt", () => {
    // `<!--` is not tag-shaped, so the tag strip alone would pass it through
    // to innerHTML, where it comments out everything after it.
    expect(sanitizeExcerpt("a <!-- b <mark>hit</mark>")).toBe(
      "a &lt;!-- b <mark>hit</mark>"
    );
    expect(sanitizeExcerpt("<?bogus comment>")).toBe("&lt;?bogus comment>");
  });

  it("cannot be spliced into a fresh tag by a dropped one", () => {
    // Deleting `<b>` in place would leave `<script>` behind; scanning every
    // `<` instead leaves the leftovers as inert text.
    expect(sanitizeExcerpt("<<b>script>alert(1)</b>")).toBe(
      "&lt;script>alert(1)"
    );
    expect(sanitizeExcerpt("<scr<b>ipt>alert(1)")).toBe("ipt>alert(1)");
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

// SAFETY: only the fields the RSS builder reads; the rest of PageRecord is
// immaterial to these feeds.
const blogPage = (over: Partial<PageRecord>): PageRecord =>
  ({
    contentType: "blog",
    description: "desc",
    meta: pageMetaSchema.parse({}),
    route: "/blog/a",
    title: "A",
    ...over,
  }) as PageRecord;

// SAFETY: buildRssFeeds reads only the config and the graph's pages; the
// rest of BlumeProject is immaterial to these feeds.
const rssProject = (pages: PageRecord[]): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://x.test" },
      description: "D",
      title: "T",
    }),
    graph: { pages },
  }) as BlumeProject;

describe("buildRssFeeds — pages without a date", () => {
  it("includes a publishable page that declares no date", () => {
    const [feed] = buildRssFeeds(rssProject([blogPage({})]));
    expect(feed?.items.map((item) => item.title)).toStrictEqual(["A"]);
    expect(feed?.items[0]?.date).toBeUndefined();
  });

  it("renders an item with no pubDate when the page has no date", () => {
    const [feed] = buildRssFeeds(rssProject([blogPage({})]));
    // SAFETY: the single blog page above always yields exactly one feed.
    const xml = renderRssFeed(feed as RssFeed);
    expect(xml).toContain("<title>A</title>");
    expect(xml).not.toContain("<pubDate>");
  });
});

const componentSource = (path: string): Promise<string> =>
  readFile(new URL(`../src/components/${path}`, import.meta.url), "utf-8");

const layoutSource = (name: string): Promise<string> =>
  componentSource(`layout/${name}`);

/**
 * Every `.astro` file under `src/` that imports the named component. The
 * single-importer tests below use it to pin which pages can ever carry a
 * lazy panel's loader script.
 */
const astroImportersOf = async (component: string): Promise<string[]> => {
  const srcRoot = new URL("../src/", import.meta.url).pathname;
  const importPattern = new RegExp(
    String.raw`from\s+"[^"]*${component}\.astro"`,
    "u"
  );
  const importers: string[] = [];
  for await (const file of new Bun.Glob("**/*.astro").scan(srcRoot)) {
    const source = await readFile(join(srcRoot, file), "utf-8");
    if (importPattern.test(source)) {
      importers.push(file);
    }
  }
  return importers;
};

describe("layout chrome sources", () => {
  it("toggles the search dialog on ⌘K and guards re-entrant opens", async () => {
    const source = await layoutSource("Search.astro");
    // ⌘K closes an open dialog (mirroring Ask AI's ⌘I toggle) instead of
    // calling showModal on it — a no-op on evergreen browsers but an
    // InvalidStateError on older ones.
    expect(source).toContain("this.dialog.close();");
    expect(source).toMatch(
      /if \(this\.dialog\.open\) \{\s*this\.dialog\.close\(\);\s*\} else \{\s*this\.open\(\);/u
    );
    // "/" stays open-only behind the field guard.
    expect(source).toContain(
      'event.key === "/" && !this.isField(event.target)'
    );
    // open() itself refuses to re-showModal an already-open dialog.
    expect(source).toMatch(
      /async open\(\) \{[^}]*if \(this\.dialog\.open\) \{\s*return;/u
    );
  });

  it("localizes the search section-filter All pill", async () => {
    const source = await layoutSource("Search.astro");
    expect(source).toContain("data-i18n-all={s.all}");
    expect(source).toContain("this.createPill(this.allMsg, total, null)");
    expect(source).not.toContain('this.createPill("All"');
  });

  it("localizes the breadcrumb and pagination landmark labels", async () => {
    const breadcrumbs = await layoutSource("Breadcrumbs.astro");
    expect(breadcrumbs).toContain("aria-label={n.breadcrumb}");
    const pagination = await layoutSource("Pagination.astro");
    expect(pagination).toContain("aria-label={s.pagination}");
    // RootLayout forwards the nav dictionary to the breadcrumbs slot.
    const root = await layoutSource("RootLayout.astro");
    expect(root).toContain("strings={navStrings}");
  });

  it("mirrors the NavTree back arrow and drill-in chevron under RTL", async () => {
    const source = await layoutSource("NavTree.astro");
    expect(source).toContain('class="rtl:-scale-x-100" name="arrow-left"');
    expect(source).toContain(
      'class="shrink-0 text-muted-foreground rtl:-scale-x-100"'
    );
  });

  it("resolves the display mode per node, never from a global prop", async () => {
    // The builder stamps each generated group with its resolved display
    // (index frontmatter > folder meta > global); the renderer must read that
    // node value for both the row branches and the drill-in panel collection,
    // or per-group overrides silently regress to the sidebar-wide mode.
    const source = await layoutSource("NavTree.astro");
    expect(source).toContain('const display = item.display ?? "flat";');
    expect(source).toContain('(node.display ?? "flat") === "page"');
  });

  it("uses the sidebar row radius for the full-width NavTree back button", async () => {
    const source = await layoutSource("NavTree.astro");
    expect(source).toMatch(
      /class="[^"]*w-full[^"]*rounded-\[0\.65rem\][^"]*"[\s\S]*?data-nav-back=\{panel\.parentId\}/u
    );
  });

  it("never pairs the generic rounded utility with a muted row background", async () => {
    // Every hoverable/active sidebar row shares the 0.65rem navigation radius;
    // a bare `rounded` next to `bg-muted` renders a mismatched 4px corner.
    const source = await layoutSource("NavTree.astro");
    for (const match of source.matchAll(/class="[^"]*"/gu)) {
      if (/(?:^|[\s"])rounded(?:$|[\s"])/u.test(match[0])) {
        expect(match[0]).not.toContain("bg-muted");
      }
    }
  });

  it("rotates a collapsible disclosure's indicator from its own details only", async () => {
    // `group-open:` matches any descendant of an open `.group`, and each of
    // these disclosures nests inside others of the same kind (sidebar groups,
    // tree folders, accordions in MDX, object schemas), so a collapsed child's
    // indicator reflected an open ancestor's state instead of its own.
    const disclosures = [
      "layout/NavTree.astro",
      "content/TreeFolder.astro",
      "content/AccordionItem.astro",
      "openapi/SchemaProperty.astro",
    ];
    const sources = await Promise.all(disclosures.map(componentSource));
    for (const source of sources) {
      expect(source).not.toContain("group-open:");
      expect(source).toContain("[details[open]>summary_&]:");
    }
  });

  it("gives the reference shell lang/dir and a skip link", async () => {
    const source = await layoutSource("ReferenceLayout.astro");
    expect(source).toContain("<html dir={dir} lang={locale}>");
    expect(source).toContain('href="#blume-content"');
    expect(source).toContain('id="blume-content"');
    expect(source).toContain("{strings.page.skipToContent}");
  });
});

/** The JSON-LD node fields this test asserts on. */
interface JsonLdArticle {
  "@type"?: unknown;
  dateModified?: unknown;
  datePublished?: unknown;
  inLanguage?: unknown;
}

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
    // SAFETY: buildStructuredData always emits `@graph` as an array of
    // schema.org node objects.
    const graph = (data?.["@graph"] ?? []) as JsonLdArticle[];
    const article = graph.find((node) => node["@type"] === "TechArticle");
    expect(article?.dateModified).toBe("2026-02-01T00:00:00.000Z");
    expect(article?.inLanguage).toBe("fr");
    expect(article?.datePublished).toBeUndefined();
  });
});

describe("openapi playground sources", () => {
  it("loads the playground client lazily behind the details toggle", async () => {
    // The client module must stay a dynamic import: it becomes its own chunk,
    // downloaded only when a reader actually opens the Try It panel.
    const source = await componentSource("openapi/Playground.astro");
    expect(source).toContain('await import("./playground-client.ts")');
    expect(source).toContain("initPlayground(this)");
    expect(source).toContain("{ once: true }");
  });

  it("keeps operation renderers the only importers of Playground.astro", async () => {
    // The no-playground-JS-on-non-operation-pages guarantee: any other .astro
    // importing the panel would pull its loader script onto that page too.
    // GraphqlOperation renders only via Operation.astro's kind dispatch, so
    // both importers still sit exclusively on operation pages.
    const importers = await astroImportersOf("Playground");
    expect(importers.toSorted()).toEqual([
      "components/openapi/GraphqlOperation.astro",
      "components/openapi/Operation.astro",
    ]);
  });

  it("tags each request-sample pane with its language for live sync", async () => {
    // The playground client re-renders samples by [data-sample-lang]; the
    // attribute must ride the same element as the tab-switcher's data-panel,
    // and only request samples opt in (response/message panels pass no lang).
    expect(await componentSource("openapi/PanelTabs.astro")).toMatch(
      /data-panel=\{panel\.key\}\s+data-sample-lang=\{panel\.lang\}/u
    );
    expect(await componentSource("openapi/RequestPanel.astro")).toContain(
      "lang: language.id"
    );
  });
});

describe("asyncapi composer sources", () => {
  it("loads the composer client lazily behind the details toggle", async () => {
    // Same island discipline as the OpenAPI panel: its own chunk, downloaded
    // only when a reader actually opens the composer.
    const source = await componentSource("openapi/MessageComposer.astro");
    expect(source).toContain('await import("./message-composer.ts")');
    expect(source).toContain("initComposer(this)");
    expect(source).toContain("{ once: true }");
  });

  it("keeps AsyncApiOperation.astro the only importer of MessageComposer.astro", async () => {
    expect(await astroImportersOf("MessageComposer")).toEqual([
      "components/openapi/AsyncApiOperation.astro",
    ]);
  });

  it("tags each event-sample pane with its tool id for live sync", async () => {
    expect(await componentSource("openapi/AsyncApiOperation.astro")).toContain(
      "lang: language.id"
    );
  });
});
