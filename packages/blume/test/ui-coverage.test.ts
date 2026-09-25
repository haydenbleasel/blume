import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { join } from "pathe";

import { extractTypeTable } from "../src/components/content/auto-type-table.ts";
import { fetchRepositoryInfo } from "../src/components/content/github-info.ts";
import {
  findBreadcrumbs,
  flattenPages,
  getPagination,
  hasDeferrableGroups,
  hiddenDefaultLocale,
  navGroupIds,
  navVariants,
} from "../src/components/layout/nav-utils.ts";
import { searchLocaleFor } from "../src/components/layout/search-locale.ts";
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

const navPage = (route: string): NavNode => ({
  kind: "page",
  label: route,
  pageId: route,
  route,
});

const navGroup = (
  label: string,
  children: NavNode[],
  display: "flat" | "group" | "page" = "flat"
): NavNode => ({ children, display, kind: "group", label });

describe("navGroupIds", () => {
  it("numbers every group by pre-order position, keyed by identity", () => {
    const nested = navGroup("Nested", [navPage("/a/b")], "group");
    const a = navGroup("A", [navPage("/a"), nested]);
    const b = navGroup("B", [navPage("/b")], "page");
    const ids = navGroupIds([navPage("/"), a, b]);
    expect([...ids.values()]).toEqual(["g0", "g1", "g2"]);
    expect(ids.get(nested)).toBe("g1");
    // A scoped view (a tab's section) holds the same node objects, so the
    // ids it resolves match the full tree's.
    expect(navGroupIds([navPage("/"), a, b]).get(b)).toBe("g2");
  });

  it("lists every navigation tree by version and locale segment", () => {
    // SAFETY: only the sidebar is read; the rest of a Navigation (tabs,
    // selectors, root) is irrelevant to the variant walk.
    const tree = (label: string) =>
      ({
        root: "/",
        selectors: [],
        sidebar: [navGroup(label, [])],
        tabs: [],
      }) as never;
    const variants = navVariants({
      navigation: tree("default"),
      navigationByLocale: { ja: tree("ja") },
      navigationByVersion: { "v1.0": { "": tree("v1"), ja: tree("v1-ja") } },
    });
    expect(
      variants.map((variant) => `${variant.version}/${variant.locale}`)
    ).toEqual(["current/default", "current/ja", "v1.0/default", "v1.0/ja"]);
  });

  it("keys the hidden-prefix default locale's trees as default", () => {
    // Astro's i18n routing 404s a page URL with the default locale's code as
    // a segment while that locale is unprefixed, so `/blume-nav/…/de/…` is
    // never emitted for it: its current tree is `navigation` already, and its
    // archived trees take the `default` segment too.
    // SAFETY: only the sidebar is read; the rest of a Navigation (tabs,
    // selectors, root) is irrelevant to the variant walk.
    const tree = (label: string) =>
      ({
        root: "/",
        selectors: [],
        sidebar: [navGroup(label, [])],
        tabs: [],
      }) as never;
    const variants = navVariants(
      {
        navigation: tree("de"),
        navigationByLocale: { de: tree("de"), en: tree("en") },
        navigationByVersion: {
          "v1.0": { de: tree("v1-de"), en: tree("v1-en") },
        },
      },
      "de"
    );
    expect(
      variants.map((variant) => `${variant.version}/${variant.locale}`)
    ).toEqual(["current/default", "current/en", "v1.0/default", "v1.0/en"]);
    expect(variants[2]?.navigation.sidebar[0]?.label).toBe("v1-de");
  });

  it("hides the default locale only while its prefix is hidden", () => {
    expect(hiddenDefaultLocale(null)).toBeNull();
    expect(
      hiddenDefaultLocale({
        defaultLocale: "de",
        hideDefaultLocalePrefix: false,
      })
    ).toBeNull();
    expect(
      hiddenDefaultLocale({
        defaultLocale: "de",
        hideDefaultLocalePrefix: true,
      })
    ).toBe("de");
  });

  it("reports whether any group is a disclosure or drill-in panel", () => {
    expect(hasDeferrableGroups([navGroup("A", [navPage("/a")])])).toBe(false);
    expect(
      hasDeferrableGroups([
        navGroup("A", [navGroup("Inner", [navPage("/a")], "group")]),
      ])
    ).toBe(true);
    expect(hasDeferrableGroups([navGroup("B", [navPage("/b")], "page")])).toBe(
      true
    );
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

const componentSource = async (path: string): Promise<string> => {
  const source = await readFile(
    new URL(`../src/components/${path}`, import.meta.url),
    "utf-8"
  );
  // A Windows checkout may carry CRLF line endings; the assertions below
  // quote multi-line source as it is authored.
  return source.replaceAll("\r\n", "\n");
};

const layoutSource = (name: string): Promise<string> =>
  componentSource(`layout/${name}`);

/**
 * Every `.astro` file under `src/` that imports the named component. The
 * single-importer tests below use it to pin which pages can ever carry a
 * lazy panel's loader script.
 */
const astroImportersOf = async (component: string): Promise<string[]> => {
  // A real path, not `URL.pathname`: that keeps percent-encoding (a space in
  // the checkout path) and isn't a native path on Windows.
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const importPattern = new RegExp(
    String.raw`from\s+"[^"]*${component}\.astro"`,
    "u"
  );
  const importers: string[] = [];
  for await (const file of new Bun.Glob("**/*.astro").scan(srcRoot)) {
    const source = await readFile(join(srcRoot, file), "utf-8");
    if (importPattern.test(source)) {
      importers.push(file.replaceAll("\\", "/"));
    }
  }
  return importers;
};

describe("layout chrome sources", () => {
  it("describes every new-tab link with the page's one localized hint", async () => {
    // Each page shell renders the hidden hint once; every chrome and content
    // link that opens a new tab points aria-describedby at it through the
    // shared helpers, never a hand-written target.
    const layouts = await Promise.all(
      ["RootLayout.astro", "PageLayout.astro", "ReferenceLayout.astro"].map(
        layoutSource
      )
    );
    for (const layout of layouts) {
      expect(layout).toContain(
        "<span hidden id={NEW_TAB_HINT_ID}>{navStrings.opensInNewTab}</span>"
      );
    }
    const links = await Promise.all(
      [
        "layout/RootLayout.astro",
        "layout/Header.astro",
        "layout/PageActions.astro",
        "content/Card.astro",
        "content/GithubInfo.astro",
        "content/Tile.astro",
        "content/Tooltip.astro",
      ].map(componentSource)
    );
    for (const source of links) {
      expect(source).toMatch(/\{\.\.\.(?:NEW_TAB_ATTRS|newTabAttrs\()/u);
      expect(source).not.toContain('target="_blank"');
      expect(source).not.toContain('startsWith("http")');
    }
  });

  it("toggles the search dialog on ⌘K and guards re-entrant opens", async () => {
    const source = await layoutSource("Search.astro");
    // ⌘K closes an open dialog (mirroring the assistant's ⌘I toggle) instead of
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
    // Modal surfaces hold independent root attributes so one surface cannot
    // release another's scroll lock (for example, nav closing on resize while
    // search remains open).
    expect(source).toContain(
      'this.dialog.addEventListener("close", () => this.unlockPageScroll());'
    );
    expect(source).toContain(
      'document.documentElement.setAttribute("data-blume-search-dialog-open", "");'
    );
    expect(source).toContain(
      'document.documentElement.removeAttribute("data-blume-search-dialog-open");'
    );
    const header = await layoutSource("Header.astro");
    expect(header).not.toContain("d.style.overflow");
    const { tailwindEntryTemplate } = await import("../src/theme/entry.ts");
    const css = tailwindEntryTemplate({
      configTokens: "",
      sources: [],
      userTheme: "",
    });
    expect(css).toContain(
      "html:where([data-blume-nav-open], [data-blume-search-dialog-open])"
    );
    expect(css).toContain("overflow: hidden !important;");
    expect(css).toContain("scrollbar-gutter: stable;");
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

  it("links the header logo to the active locale's root", async () => {
    // The brand link follows the reader's locale like the tabs beside it:
    // Logo.astro takes the href the locale's navigation resolved (moved into
    // the locale only when it serves that route), falling back to the same
    // helper the per-locale tab paths use, and every layout that renders the
    // header hands it the page locale to do so.
    const logo = await layoutSource("Logo.astro");
    expect(logo).toContain("data.navigationByLocale[locale]?.brandHref");
    expect(logo).toContain(
      "localizeInternalPath(configuredHref, locale, data.config.i18n)"
    );
    expect(logo).toContain('const configuredHref = logo?.href ?? "/";');
    const header = await layoutSource("Header.astro");
    expect(header).toContain(
      "<LogoSlot locale={locale} logo={logo} site={site} />"
    );
    const layouts = await Promise.all(
      ["RootLayout.astro", "PageLayout.astro", "ReferenceLayout.astro"].map(
        layoutSource
      )
    );
    for (const layout of layouts) {
      expect(layout).toMatch(/<Header(?:Slot)?\s[^>]*locale=\{locale\}/u);
    }
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

  it("renders sidebar page rows through the theme's row utility", async () => {
    // Every page's HTML carries the whole sidebar, so a page row is one
    // utility class (defined once in the theme) rather than the dozen it
    // expands to; the bare row also drops the inner row spans. The utility
    // and the component reference each other by name, so both sides are
    // pinned here.
    const source = await layoutSource("NavTree.astro");
    expect(source).toContain('class="blume-nav-link truncate"');
    expect(source).toContain('class="blume-nav-link"');
    expect(source).not.toContain(
      "block rounded-[0.65rem] px-2.5 py-1.5 text-muted-foreground"
    );
    const { tailwindEntryTemplate } = await import("../src/theme/entry.ts");
    const css = tailwindEntryTemplate({
      configTokens: "",
      sources: [],
      userTheme: "",
    });
    expect(css).toContain("@utility blume-nav-link {");
    expect(css).toMatch(
      /@utility blume-nav-link \{\n\s+@apply block rounded-\[0\.65rem\][^;]*aria-\[current=page\]:text-foreground;/u
    );
    // The group rows too: every utility the tree references is defined once
    // in the theme, and the tree references each of them.
    for (const utility of [
      "blume-nav-drill",
      "blume-nav-summary",
      "blume-nav-summary-link",
      "blume-nav-heading",
      "blume-nav-heading-link",
    ]) {
      expect(css).toContain(`@utility ${utility} {`);
      expect(source).toContain(`class="${utility}"`);
    }
  });

  it("renders set icons through the page sprite and emits it from every shell", async () => {
    // A set icon is a <use> reference when the shell keeps a sprite, and each
    // shell starts the registry up front and emits the sprite last in <body>
    // (see icon-sprite.ts); a shell override without one gets inline icons.
    const icon = await componentSource("Icon.astro");
    expect(icon).toContain("registerIconSymbol(sprite, resolvedIcon.name, {");
    expect(icon).toContain(`<use href={\`#\${symbolId}\`} />`);
    expect(icon).toContain("set:html={resolvedIcon.body}");
    const shells = await Promise.all(
      ["RootLayout.astro", "PageLayout.astro", "ReferenceLayout.astro"].map(
        layoutSource
      )
    );
    for (const source of shells) {
      expect(source).toContain("createIconSprite(Astro.locals);");
      expect(source).toMatch(/<IconSprite \/>\s*<\/body>/u);
    }
    // The shell only leaves the slot; the middleware fills it once the page
    // has rendered, which is the only point where every icon is registered.
    const slot = await layoutSource("IconSprite.astro");
    expect(slot).toContain("<Fragment set:html={ICON_SPRITE_SLOT} />");
    expect(slot).not.toContain("renderIconSprite");
    const cache = await layoutSource("NavTreeCache.astro");
    expect(cache).toContain("referencedIconSymbols(rendered)");
  });

  it("loads Mermaid and the EPUB generator through the generated feature loaders", async () => {
    // A direct import would put the library in every site's client bundle;
    // the loaders are null (and the library absent) for sites that don't use
    // the feature.
    const root = await layoutSource("RootLayout.astro");
    expect(root).toContain('import { loadMermaid } from "blume:features";');
    expect(root).toContain("loadMermaid?.();");
    expect(root).not.toContain('import "../content/mermaid-element.ts"');
    const actions = await layoutSource("PageActions.astro");
    expect(actions).toContain('await import("blume:features")');
    expect(actions).toContain("await loadEpub()");
    expect(actions).not.toContain('import("epub-gen-memory/bundle")');
  });

  it("defers collapsed sections and inactive panels to fetched fragments", async () => {
    // With a fragment base, a closed group's children and an inactive
    // drill-in panel's contents stay out of the page; the empty element
    // carries the fragment URL the script fills on first open. Without one,
    // every section renders (the cache handles the repeats).
    const source = await layoutSource("NavTree.astro");
    expect(source).toContain(
      "data-nav-src={open ? undefined : fragmentFor(item, id)}"
    );
    expect(source).toContain(
      "{!open && fragmentFor(item, id) ? null : active ? ("
    );
    expect(source).toContain(
      "const src = panel.active ? undefined : fragmentFor(panel.node, panel.id);"
    );
    expect(source).toContain("data-nav-src={src}");
    expect(source).toContain(") : src ? null : (");
    // A group the tab scoping rebuilt has no stable id, so it has no fragment
    // and renders in full.
    expect(source).toContain("fragmentBase && (ids?.has(node) ?? true) ?");
    // Ids come from the full tree so scoped views and fragments agree.
    expect(source).toContain(
      `const id = idOf(item, \`\${idPrefix}.\${index}\`);`
    );
    expect(source).toContain(
      "root && (panels.length > 0 || fragmentBase) && <NavTreeScript />"
    );
    const script = await layoutSource("NavTreeScript.astro");
    expect(script).toContain(
      'fetch(src, { headers: { Accept: "text/html" } })'
    );
    expect(script).toContain('document.addEventListener(\n      "toggle",');
    expect(script).toContain("await fillDeferred(next);");
    const root = await layoutSource("RootLayout.astro");
    expect(root).toContain("const navIds = navGroupIds(navigation.sidebar);");
    expect(root).toContain("fragmentBase={navFragmentBase}");
  });

  it("renders the sidebar drill-in script once, from the root tree", async () => {
    // Cached subtrees (NavTreeCache) replay their first render on every later
    // page, so the `<blume-nav>` script lives in its own component that only
    // the root tree renders — never inside a cacheable subtree.
    const source = await layoutSource("NavTree.astro");
    expect(source).not.toContain("<script>");
    expect(source).toContain("<NavTreeScript />");
    expect(source).toMatch(
      /<NavTreeScript \/>\}\s*\{\s*root && panels\.length > 0 \? \(\s*<blume-nav/u
    );
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

  it("advertises agent discovery from the snapshot in every shell", async () => {
    // A custom page on `PageLayout` (the generated 404 included) never passes a
    // `discovery` prop, so the shell has to fall back to the resolved snapshot
    // or that page silently loses the `describedby` / `ai-catalog` / `ard`
    // links the docs pages carry. `RootLayout` and the Scalar `ReferenceLayout`
    // default it too, so every page shell is covered without wiring anything
    // up — and all three render the one `DiscoveryLinks` partial, so the head
    // block has a single definition to keep in sync.
    const shells = [
      "PageLayout.astro",
      "ReferenceLayout.astro",
      "RootLayout.astro",
    ];
    const sources = await Promise.all(shells.map(layoutSource));
    for (const source of sources) {
      expect(source).toContain("discovery = data.config.discovery,");
      expect(source).toContain("<DiscoveryLinks discovery={discovery}");
    }
    const partial = await layoutSource("DiscoveryLinks.astro");
    expect(partial).toContain('rel="describedby"');
    expect(partial).toContain('rel="ai-catalog"');
    expect(partial).toContain('rel="ard"');
    // `discovery={null}` drops every link the partial renders, the Markdown
    // alternate included — it must not survive the opt-out on its own.
    expect(partial).toContain("discovery && markdownMirror && (");
    expect(partial).toContain('rel="alternate" type="text/markdown"');
  });

  it("advertises a generated OG card only for static custom routes", async () => {
    // Cards are generated per static custom page (`customOgRoutes` skips
    // `[param]` routes), so a dynamic page must not point `og:image` at a card
    // the build never renders.
    const source = await layoutSource("PageLayout.astro");
    expect(source).toContain(
      'const ogCardGenerated = !Astro.routePattern.includes("[");'
    );
    expect(source).toContain(": ogEnabled && ogCardGenerated && siteBase");
  });

  it("advertises the homepage Markdown mirror from PageLayout", async () => {
    // `/index.md` always exists (`markdownRoutePaths` appends the root; a
    // landing page gets the synthesized llms.txt index), and the homepage HTTP
    // `Link` header already advertises it — so a PageLayout homepage must carry
    // the same `alternate` in its head for hosts that can't set that header,
    // while any other custom route (no mirror) must not advertise one.
    const source = await layoutSource("PageLayout.astro");
    expect(source).toContain(
      'const markdownMirror = route === "/" ? withMountedBase("/index.md") : null;'
    );
    // The documented homepage examples omit `page.route`; a non-root page that
    // copies them must resolve its own route from the request URL, or it
    // would advertise `/index.md` (and the homepage canonical) as its own.
    expect(source).toContain(
      'stripBase(import.meta.env.BASE_URL ?? "/", Astro.url.pathname)'
    );
    expect(source).toContain(
      "<DiscoveryLinks discovery={discovery} markdownMirror={markdownMirror} />"
    );
    // The reference shell has no mirror to advertise: no `markdownMirror` prop.
    const reference = await layoutSource("ReferenceLayout.astro");
    expect(reference).toContain("<DiscoveryLinks discovery={discovery} />");
  });

  it("scopes search to the page locale from the i18n snapshot in every shell", async () => {
    // The switcher list only exists on catch-all content pages; deriving the
    // search locale from it left custom pages, the changelog index, the 404
    // page, and the reference shell searching every language.
    const shells = [
      "PageLayout.astro",
      "RootLayout.astro",
      "ReferenceLayout.astro",
    ];
    const sources = await Promise.all(shells.map(layoutSource));
    for (const source of sources) {
      expect(source).toContain(
        'import { searchLocaleFor } from "./search-locale.ts";'
      );
      expect(source).toContain(
        "const searchLocale = searchLocaleFor(data.config.i18n, locale);"
      );
      expect(source).toContain("searchLocale={searchLocale}");
      expect(source).not.toContain("localeSwitch.length > 1 ? locale");
    }
  });

  it("defaults the document locale to Astro.currentLocale in every shell", async () => {
    // A custom page under `/fr/` built on PageLayout has no manifest locale to
    // pass, so the shells fall back to what Astro's i18n routing resolved for
    // the URL rather than hard-coding `en`.
    const shells = [
      "PageLayout.astro",
      "RootLayout.astro",
      "ReferenceLayout.astro",
    ];
    const sources = await Promise.all(shells.map(layoutSource));
    for (const source of sources) {
      expect(source).toContain(
        'import { pageDirection, pageLocale } from "./page-locale.ts";'
      );
      expect(source).toContain(
        "const locale = pageLocale(data.config.i18n, localeProp, Astro.currentLocale);"
      );
      expect(source).toContain(
        "const dir = dirProp ?? pageDirection(data.config.i18n, locale);"
      );
      expect(source).not.toContain('locale = "en",');
    }
  });

  it("scopes Pagefind to indexable articles and marks a fallback article's language", async () => {
    const root = await layoutSource("RootLayout.astro");
    // Only a content page's article is indexed; the chrome, the changelog
    // index (bare), and every page without the attribute drop out.
    expect(root).toContain(
      'data-pagefind-body={indexable && !isBare ? "" : undefined}'
    );
    expect(root).toContain(
      "contentLocale && contentLocale !== locale ? contentLocale : undefined"
    );
    expect(root).toContain("lang={articleLang}");
    // A page titled like the site isn't suffixed with it again.
    expect(root).toContain("page.title && page.title !== site.title");
  });

  it("keeps the header's bidi-neutral text and dropdown panels readable", async () => {
    expect(await layoutSource("Banner.astro")).toContain(
      '<span dir="auto">{banner.content}</span>'
    );
    const search = await layoutSource("Search.astro");
    expect(search.match(/dir="ltr">⌘[JK]<\/kbd/gu)).toHaveLength(2);
    const selector = await layoutSource("NavSelector.astro");
    expect(selector).toContain("data-blume-dropdown-panel");
    expect(selector).toContain("max-w-[calc(100vw-1rem)]");
    expect(selector).toContain("installDropdownClamp();");
  });
});

describe("searchLocaleFor", () => {
  it("returns the locale on a multi-locale site", () => {
    const i18n = { locales: [{ code: "en" }, { code: "de" }] };
    expect(searchLocaleFor(i18n, "de")).toBe("de");
  });

  it("disables scoping without i18n or with a single locale", () => {
    expect(searchLocaleFor(null, "en")).toBeUndefined();
    expect(
      searchLocaleFor({ locales: [{ code: "en" }] }, "en")
    ).toBeUndefined();
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
    // The tagging itself lives in the shared panel builder every operation
    // renderer uses (sample-panels.ts).
    expect(await componentSource("openapi/PanelTabs.astro")).toMatch(
      /data-panel=\{panel\.key\}\s+data-sample-lang=\{panel\.lang\}/u
    );
    expect(await componentSource("openapi/sample-panels.ts")).toContain(
      "lang: language.id"
    );
    expect(await componentSource("openapi/RequestPanel.astro")).toContain(
      "languageSamplePanels"
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
    // Via the shared panel builder — see the request-sample test above.
    expect(await componentSource("openapi/AsyncApiOperation.astro")).toContain(
      "languageSamplePanels"
    );
  });
});
