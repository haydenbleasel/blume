import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildMcpData } from "../src/ai/mcp/data.ts";
import type { McpData } from "../src/ai/mcp/data.ts";
import {
  buildMcpDiscovery,
  buildMcpServerCard,
} from "../src/ai/mcp/discovery.ts";
import { createMcpFetchHandler } from "../src/ai/mcp/server.ts";
import { MCP_TOOLS } from "../src/ai/mcp/tools.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { buildOramaIndex, queryOramaIndex } from "../src/search/orama-index.ts";

const DATA: McpData = {
  base: "",
  documents: [
    {
      content:
        "Install Blume with your package manager, then run the dev server to preview the docs.",
      description: "How to install Blume",
      route: "/guides/install",
      title: "Installation",
    },
    {
      content:
        "Configure themes, navigation, and search in blume.config.ts to customize the site.",
      description: "Configuration reference",
      route: "/guides/config",
      title: "Configuration",
    },
  ],
  name: "Test Docs",
  navigation: {
    featured: [],
    selectors: [],
    sidebar: [
      {
        kind: "page",
        label: "Installation",
        pageId: "guides/install",
        route: "/guides/install",
      },
    ],
    tabs: [{ label: "Guides", path: "/guides/install" }],
  },
  pages: {
    "/guides/config":
      "---\ntitle: Configuration\n---\n# Configuration\n\nConfigure it.",
    "/guides/install":
      "---\ntitle: Installation\n---\n# Installation\n\nInstall it.",
  },
  routes: [
    {
      contentType: "doc",
      description: "How to install Blume",
      indexable: true,
      lastModified: null,
      route: "/guides/install",
      title: "Installation",
    },
    {
      contentType: "doc",
      description: "Configuration reference",
      indexable: true,
      lastModified: null,
      route: "/guides/config",
      title: "Configuration",
    },
  ],
  site: "https://docs.example.com",
  version: "0.0.0",
};

const handler = createMcpFetchHandler(DATA);

const post = (method: string, params?: unknown): Promise<Response> =>
  handler(
    new Request("https://docs.example.com/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    })
  );

const rpc = async (method: string, params?: unknown) => {
  const response = await post(method, params);
  return (await response.json()) as {
    error?: { message: string };
    result?: Record<string, unknown>;
  };
};

const callTool = async (name: string, args?: Record<string, unknown>) => {
  const body = await rpc("tools/call", { arguments: args, name });
  const content = body.result?.content as { text: string }[] | undefined;
  return {
    isError: body.result?.isError === true,
    text: content?.[0]?.text ?? "",
  };
};

describe("createMcpFetchHandler transport", () => {
  it("answers CORS preflight without a body", async () => {
    const response = await handler(
      new Request("https://docs.example.com/mcp", { method: "OPTIONS" })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects GET (no server-initiated streams)", async () => {
    const response = await handler(
      new Request("https://docs.example.com/mcp", { method: "GET" })
    );
    expect(response.status).toBe(405);
  });

  it("lists every registered tool", async () => {
    const body = await rpc("tools/list");
    const tools = (body.result?.tools as { name: string }[]) ?? [];
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      MCP_TOOLS.map((tool) => tool.name).toSorted()
    );
  });
});

describe("MCP tools", () => {
  it("search_docs ranks the relevant page first with an absolute URL", async () => {
    const { text, isError } = await callTool("search_docs", {
      query: "install dev server",
    });
    expect(isError).toBe(false);
    const hits = JSON.parse(text) as { url: string }[];
    expect(hits[0]?.url).toBe("https://docs.example.com/guides/install");
  });

  it("search_docs honors the limit", async () => {
    const { text } = await callTool("search_docs", {
      limit: 1,
      query: "blume",
    });
    expect((JSON.parse(text) as unknown[]).length).toBe(1);
  });

  it("search_docs includes the base-less route alongside the served URL", async () => {
    const { text } = await callTool("search_docs", {
      query: "install dev server",
    });
    const hits = JSON.parse(text) as { route: string; url: string }[];
    // `route` is what `get_page` takes; `url` is where the page is served.
    expect(hits[0]?.route).toBe("/guides/install");
    expect(hits[0]?.url).toBe("https://docs.example.com/guides/install");
  });

  it("search_docs matches CJK content when the snapshot carries a default locale", async () => {
    const jaHandler = createMcpFetchHandler({
      ...DATA,
      defaultLocale: "ja",
      documents: [
        {
          content: "退会とポイントの扱いについて説明します。",
          description: "個人情報の取り扱い",
          route: "/ja/legal",
          title: "法務に相談するときの準備リスト",
        },
      ],
    });
    const response = await jaHandler(
      new Request("https://docs.example.com/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { query: "ポイント" }, name: "search_docs" },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    const body = (await response.json()) as {
      result?: { content?: { text: string }[] };
    };
    const hits = JSON.parse(body.result?.content?.[0]?.text ?? "[]") as {
      route: string;
    }[];
    expect(hits.map((hit) => hit.route)).toEqual(["/ja/legal"]);
  });

  it("get_page accepts a full page URL", async () => {
    const { text, isError } = await callTool("get_page", {
      route: "https://docs.example.com/guides/install",
    });
    expect(isError).toBe(false);
    expect(text).toContain("# Installation");
  });

  it("get_page returns the raw Markdown source", async () => {
    const { text, isError } = await callTool("get_page", {
      route: "/guides/install",
    });
    expect(isError).toBe(false);
    expect(text).toContain("# Installation");
  });

  it("get_page normalizes a .md suffix and trailing slash", async () => {
    const { text } = await callTool("get_page", {
      route: "/guides/install.md/",
    });
    expect(text).toContain("# Installation");
  });

  it("get_page reports an error for an unknown route", async () => {
    const { isError } = await callTool("get_page", { route: "/nope" });
    expect(isError).toBe(true);
  });

  it("list_pages returns every non-hidden route", async () => {
    const { text } = await callTool("list_pages");
    const routes = JSON.parse(text) as { route: string }[];
    expect(routes.map((route) => route.route).toSorted()).toEqual([
      "/guides/config",
      "/guides/install",
    ]);
  });
});

describe("MCP content-type filtering", () => {
  const TYPED: McpData = {
    ...DATA,
    documents: [
      ...DATA.documents.map((doc) => ({ ...doc, contentType: "doc" })),
      {
        content: "RFC: how Blume endpoints declare request schemas.",
        contentType: "rfc",
        description: "RFC for request validation",
        route: "/rfcs/schemas",
        title: "Request schemas",
      },
    ],
    routes: [
      ...DATA.routes,
      {
        contentType: "rfc",
        description: "RFC for request validation",
        indexable: true,
        lastModified: null,
        route: "/rfcs/schemas",
        title: "Request schemas",
      },
    ],
  };
  const typedHandler = createMcpFetchHandler(TYPED);

  const callTyped = async (name: string, args?: Record<string, unknown>) => {
    const response = await typedHandler(
      new Request("https://docs.example.com/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    const body = (await response.json()) as {
      result?: { content?: { text: string }[] };
    };
    return body.result?.content?.[0]?.text ?? "";
  };

  it("search_docs filters hits to the requested content types", async () => {
    const rfcs = JSON.parse(
      await callTyped("search_docs", { contentTypes: ["rfc"], query: "blume" })
    ) as { contentType: string; route: string }[];
    expect(rfcs.map((hit) => hit.route)).toEqual(["/rfcs/schemas"]);
    // Hits name their type, so an agent can see what it got back.
    expect(rfcs[0]?.contentType).toBe("rfc");

    const docs = JSON.parse(
      await callTyped("search_docs", { contentTypes: ["doc"], query: "blume" })
    ) as { route: string }[];
    expect(docs.map((hit) => hit.route).toSorted()).toEqual([
      "/guides/config",
      "/guides/install",
    ]);
  });

  it("search_docs treats an empty or absent contentTypes as no filter", async () => {
    const unfiltered = JSON.parse(
      await callTyped("search_docs", { contentTypes: [], query: "blume" })
    ) as unknown[];
    expect(unfiltered.length).toBe(3);
  });

  it("list_pages filters routes by content type", async () => {
    const rfcs = JSON.parse(
      await callTyped("list_pages", { contentTypes: ["rfc"] })
    ) as { route: string }[];
    expect(rfcs.map((page) => page.route)).toEqual(["/rfcs/schemas"]);

    const all = JSON.parse(
      await callTyped("list_pages", { contentTypes: ["doc", "rfc"] })
    ) as unknown[];
    expect(all.length).toBe(3);
  });

  it("get_navigation returns the navigation tree", async () => {
    const { text } = await callTool("get_navigation");
    const nav = JSON.parse(text) as { tabs: unknown[] };
    expect(nav.tabs.length).toBe(1);
  });

  it("layers deployment.base into tool URLs (routes are base-less)", async () => {
    const based = createMcpFetchHandler({ ...DATA, base: "/sub" });
    const call = async (name: string, args?: Record<string, unknown>) => {
      const response = await based(
        new Request("https://docs.example.com/sub/mcp", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: args, name },
          }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          method: "POST",
        })
      );
      const body = (await response.json()) as {
        result?: { content?: { text: string }[] };
      };
      return body.result?.content?.[0]?.text ?? "";
    };

    const pages = JSON.parse(await call("list_pages")) as { url: string }[];
    expect(pages.map((page) => page.url).toSorted()).toEqual([
      "https://docs.example.com/sub/guides/config",
      "https://docs.example.com/sub/guides/install",
    ]);

    const hits = JSON.parse(
      await call("search_docs", { query: "install dev server" })
    ) as { url: string }[];
    expect(hits[0]?.url).toBe("https://docs.example.com/sub/guides/install");
  });

  it("get_page strips deployment.base from a full URL or prefixed path", async () => {
    const based = createMcpFetchHandler({ ...DATA, base: "/sub" });
    const call = async (route: string) => {
      const response = await based(
        new Request("https://docs.example.com/sub/mcp", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { route }, name: "get_page" },
          }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          method: "POST",
        })
      );
      const body = (await response.json()) as {
        result?: { content?: { text: string }[]; isError?: boolean };
      };
      return {
        isError: body.result?.isError === true,
        text: body.result?.content?.[0]?.text ?? "",
      };
    };

    // An agent handing back a `url` from search_docs or llms.txt: the site and
    // base are peeled off down to the base-less `pages` key.
    const fromUrl = await call("https://docs.example.com/sub/guides/install");
    expect(fromUrl.isError).toBe(false);
    expect(fromUrl.text).toContain("# Installation");

    const fromPrefixed = await call("/sub/guides/install");
    expect(fromPrefixed.isError).toBe(false);
    expect(fromPrefixed.text).toContain("# Installation");
  });
});

describe("search_docs fallback excerpts", () => {
  // Pages without a description fall back to a content excerpt; the ellipsis
  // must mark real truncation only.
  const excerptHandler = createMcpFetchHandler({
    ...DATA,
    documents: [
      {
        content: "Shortpage body only.",
        description: "",
        route: "/short",
        title: "Shortpage",
      },
      {
        // 11-char head + 7-char units puts a space at index 199, so the
        // 200-char slice ends in whitespace and must be trimmed.
        content: `Longstart. ${"filler ".repeat(40)}end`,
        description: "",
        route: "/long",
        title: "Longpage",
      },
      {
        content: "",
        description: "",
        route: "/empty",
        title: "Emptypage",
      },
      {
        content: "Descpage body.",
        description: "Described here.",
        route: "/desc",
        title: "Descpage",
      },
    ],
  });

  const firstExcerpt = async (query: string): Promise<string> => {
    const response = await excerptHandler(
      new Request("https://docs.example.com/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { query }, name: "search_docs" },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    const body = (await response.json()) as {
      result?: { content?: { text: string }[] };
    };
    const hits = JSON.parse(body.result?.content?.[0]?.text ?? "[]") as {
      excerpt: string;
    }[];
    return hits[0]?.excerpt ?? "missing";
  };

  it("prefers the description when one exists", async () => {
    expect(await firstExcerpt("Descpage")).toBe("Described here.");
  });

  it("returns short content whole, with no fake truncation marker", async () => {
    expect(await firstExcerpt("Shortpage")).toBe("Shortpage body only.");
  });

  it("truncates long content with a trimmed, whitespace-free ellipsis", async () => {
    const excerpt = await firstExcerpt("Longpage");
    // The 200-char cut lands on a space; it must be trimmed before the marker.
    expect(excerpt).toMatch(/\S…$/u);
    expect(excerpt.length).toBeLessThan(201);
    expect(excerpt).toContain("Longstart.");
  });

  it("leaves an empty-content page's excerpt empty, not a bare ellipsis", async () => {
    expect(await firstExcerpt("Emptypage")).toBe("");
  });
});

describe("orama index helpers", () => {
  it("ranks a title match above a body-only match", async () => {
    const db = await buildOramaIndex(DATA.documents);
    const hits = await queryOramaIndex(db, "configuration", 5);
    expect(hits[0]?.route).toBe("/guides/config");
  });

  it("filters results to a locale when one is given", async () => {
    const db = await buildOramaIndex([
      {
        content: "Installation guide",
        description: "",
        locale: "en",
        route: "/install",
        title: "Install",
      },
      {
        content: "Guide d'installation",
        description: "",
        locale: "fr",
        route: "/fr/install",
        title: "Installation",
      },
    ]);
    const fr = await queryOramaIndex(db, "install", 5, { locale: "fr" });
    expect(fr.map((doc) => doc.route)).toEqual(["/fr/install"]);
    // No filter searches every language.
    const all = await queryOramaIndex(db, "install", 5);
    expect(all.length).toBe(2);
  });

  it("filters results to the requested content types", async () => {
    const db = await buildOramaIndex([
      {
        content: "Install Blume with your package manager.",
        contentType: "doc",
        description: "",
        route: "/install",
        title: "Install",
      },
      {
        content: "RFC: how Blume endpoints declare request schemas.",
        contentType: "rfc",
        description: "",
        route: "/rfcs/schemas",
        title: "Request schemas",
      },
      {
        // No contentType (a pre-upgrade index entry): excluded by any filter.
        content: "Blume changelog for the current release.",
        description: "",
        route: "/changelog",
        title: "Changelog",
      },
    ]);
    const rfcs = await queryOramaIndex(db, "blume", 5, {
      contentTypes: ["rfc"],
    });
    expect(rfcs.map((doc) => doc.route)).toEqual(["/rfcs/schemas"]);
    const both = await queryOramaIndex(db, "blume", 5, {
      contentTypes: ["doc", "rfc"],
    });
    expect(both.map((doc) => doc.route).toSorted()).toEqual([
      "/install",
      "/rfcs/schemas",
    ]);
    // An empty list means "no filter", matching the MCP tool contract.
    const all = await queryOramaIndex(db, "blume", 5, { contentTypes: [] });
    expect(all.length).toBe(3);
  });

  const JA_DOCS = [
    {
      content: "退会とポイントの扱いについて説明します。GDPRにも触れます。",
      description: "個人情報の取り扱い",
      locale: "ja",
      route: "/ja/legal",
      title: "法務に相談するときの準備リスト",
    },
    {
      content: "Install the CLI and run the dev server.",
      description: "",
      locale: "en",
      route: "/en/start",
      title: "Getting started",
    },
  ];

  it("matches unspaced-script content when the locale selects a segmenting tokenizer", async () => {
    // Without a locale, Orama's default English tokenizer collapses Japanese
    // text to zero tokens — the silent all-queries-miss failure this guards.
    const unsegmented = await buildOramaIndex(JA_DOCS);
    expect(await queryOramaIndex(unsegmented, "ポイント", 5)).toEqual([]);

    const db = await buildOramaIndex(JA_DOCS, "ja");
    const body = await queryOramaIndex(db, "ポイント", 5);
    expect(body.map((doc) => doc.route)).toEqual(["/ja/legal"]);
    const title = await queryOramaIndex(db, "準備", 5);
    expect(title.map((doc) => doc.route)).toEqual(["/ja/legal"]);
    // A region-qualified locale selects the same tokenizer.
    const regional = await buildOramaIndex(JA_DOCS, "ja-JP");
    const regionalHits = await queryOramaIndex(regional, "退会", 5);
    expect(regionalHits.length).toBe(1);
  });

  it("keeps Latin terms matching case-insensitively on a segmented mixed-locale index", async () => {
    const db = await buildOramaIndex(JA_DOCS, "ja");
    // English pages on a ja-default site stay searchable...
    const install = await queryOramaIndex(db, "install", 5);
    expect(install.length).toBe(1);
    // ...and ASCII terms inside Japanese text still fold case.
    const gdpr = await queryOramaIndex(db, "gdpr", 5);
    expect(gdpr.map((doc) => doc.route)).toEqual(["/ja/legal"]);
    // The locale enum filter is unaffected by the custom tokenizer.
    const en = await queryOramaIndex(db, "install", 5, { locale: "en" });
    expect(en.map((doc) => doc.route)).toEqual(["/en/start"]);
  });

  it("segments Chinese, Korean, and Thai content too", async () => {
    const cases = [
      { content: "修改搜索设置。", locale: "zh-Hans", term: "搜索" },
      { content: "검색 설정을 변경합니다.", locale: "ko", term: "설정" },
      { content: "เปลี่ยนการตั้งค่าการค้นหา", locale: "th", term: "ค้นหา" },
    ];
    const hits = await Promise.all(
      cases.map(async ({ content, locale, term }) => {
        const db = await buildOramaIndex(
          [{ content, description: "", locale, route: "/x", title: "X" }],
          locale
        );
        return await queryOramaIndex(db, term, 5);
      })
    );
    expect(hits.map((found) => found.length)).toEqual([1, 1, 1]);
  });

  // A hub page naming every law shallowly, plus the pages each law belongs to.
  // Segmenting alone cuts 資金決済法 into 資金 / 決済 / 法, and the hub carries
  // more of those fragments than any single page — the ranking this guards.
  const COMPOUND_DOCS = [
    {
      content: "資金決済法、景品表示法、下請法などの一覧。出会い系の話題も。",
      description: "扱う法令の一覧",
      locale: "ja",
      route: "/index",
      title: "法令ハブ",
    },
    {
      content: "前払式支払手段は資金決済法の対象です。",
      description: "",
      locale: "ja",
      route: "/money",
      title: "ポイント発行",
    },
    {
      content: "景品の上限は景品表示法で決まります。",
      description: "",
      locale: "ja",
      route: "/prize",
      title: "懸賞キャンペーン",
    },
    {
      content: "出会い系サイト規制法の届出が必要です。",
      description: "",
      locale: "ja",
      route: "/matching",
      title: "マッチングサービス",
    },
  ];

  it("ranks a compound term's own page above one that only shares its parts", async () => {
    const db = await buildOramaIndex(COMPOUND_DOCS, "ja");
    const routes = async (term: string) => {
      const hits = await queryOramaIndex(db, term, 5);
      return hits.map((doc) => doc.route);
    };
    const [money, prize, subcontract] = await Promise.all([
      routes("資金決済法"),
      routes("景品表示法"),
      routes("下請法"),
    ]);
    // The hub mentions the law, but the page about it comes first...
    expect(money[0]).toBe("/money");
    expect(prize[0]).toBe("/prize");
    // ...and a term no page elaborates on stops at the one naming it, instead
    // of reaching every page through a fragment as common as 法.
    expect(subcontract).toEqual(["/index"]);
  });

  it("keeps a term written with okurigana off pages sharing only its tail", async () => {
    const db = await buildOramaIndex(COMPOUND_DOCS, "ja");
    // 出会い系 segments to 出会い / 系; without bigrams 系 alone would pull in
    // any page using it as a suffix.
    const hits = await queryOramaIndex(db, "出会い系サイト規制法", 5);
    expect(hits.map((doc) => doc.route)).toEqual(["/matching"]);
  });

  it("pairs ideographs from outside the basic plane without splitting them", async () => {
    // 𠮟 (U+20B9F) is a surrogate pair: cutting windows by code unit would
    // index half of it. It is the 常用漢字表 form of しかる, not a curiosity.
    const db = await buildOramaIndex(
      [
        {
          content: "𠮟責は懲戒処分にあたります。",
          description: "",
          locale: "ja",
          route: "/scold",
          title: "懲戒",
        },
        {
          content: "責任の所在を明確にします。",
          description: "",
          locale: "ja",
          route: "/other",
          title: "責任",
        },
      ],
      "ja"
    );
    const hits = await queryOramaIndex(db, "𠮟責", 5);
    expect(hits.map((doc) => doc.route)).toEqual(["/scold"]);
  });

  it("leaves Han content alone on an index that is not bigrammed", async () => {
    // Korean and Thai indexes keep segmented words throughout, so the query
    // side's loose matching stays consistent with how they were indexed.
    const docs = [
      {
        content: "검색 설정. 資金決済法 관련.",
        description: "",
        locale: "ko",
        route: "/ko",
        title: "설정",
      },
    ];
    const db = await buildOramaIndex(docs, "ko");
    const korean = await queryOramaIndex(db, "설정", 5);
    expect(korean.length).toBe(1);
    // Segmented whole, so a fragment of the compound matches it as before.
    const fragment = await queryOramaIndex(db, "資金", 5);
    expect(fragment.length).toBe(1);
  });

  it("matches a lone character through the bigrams it opens", async () => {
    const db = await buildOramaIndex(COMPOUND_DOCS, "ja");
    // Mid-composition input is one character long, so it is queried as itself
    // and Orama prefix-matches the bigrams it opens — 法の, 法で, 法な here.
    const hits = await queryOramaIndex(db, "法", 5);
    expect(hits.length).toBeGreaterThan(0);
    // A page where the character only closes a run is out of reach: 法 sits in
    // 示法, which the query does not prefix-match. That is the cost of dropping
    // fragment tokens, shared with Lucene's CJK analyzer.
    const runFinal = await buildOramaIndex(
      [
        {
          content: "景品表示法。",
          description: "",
          locale: "ja",
          route: "/closing",
          title: "余白",
        },
      ],
      "ja"
    );
    expect(await queryOramaIndex(runFinal, "法", 5)).toEqual([]);
  });

  it("falls back to any-token matching when no page carries the whole term", async () => {
    const db = await buildOramaIndex(COMPOUND_DOCS, "ja");
    // Nothing states this in full, so the strict pass finds nothing — a
    // sentence-like query still returns its closest pages rather than none.
    const hits = await queryOramaIndex(
      db,
      "資金決済法の前払式支払手段について",
      5
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it("leaves Latin, Hangul and Thai terms whole", async () => {
    const db = await buildOramaIndex(JA_DOCS, "ja");
    const install = await queryOramaIndex(db, "install", 5);
    expect(install.length).toBe(1);
    // Bigramming Latin would index "se", "er", "rv"… so an interior window of
    // "server" would match. Orama matches tokens by prefix, so the window has
    // to be one no indexed word starts with.
    expect(await queryOramaIndex(db, "rv", 5)).toEqual([]);

    // Hangul and Thai keep their segmented words, so a whole word still hits.
    const spaced = [
      { content: "검색 설정을 변경합니다.", locale: "ko", term: "설정" },
      { content: "เปลี่ยนการตั้งค่าการค้นหา", locale: "th", term: "ค้นหา" },
    ];
    const found = await Promise.all(
      spaced.map(async ({ content, locale, term }) => {
        const other = await buildOramaIndex(
          [{ content, description: "", locale, route: "/x", title: "X" }],
          locale
        );
        return await queryOramaIndex(other, term, 5);
      })
    );
    expect(found.map((hits) => hits.length)).toEqual([1, 1]);
  });

  it("falls back to the default tokenizer when Intl.Segmenter is unavailable", async () => {
    // Simulate a runtime without Intl.Segmenter (e.g. Firefox before 125).
    const intl = Intl as { Segmenter?: typeof Intl.Segmenter };
    const original = intl.Segmenter;
    intl.Segmenter = undefined;
    try {
      const db = await buildOramaIndex(JA_DOCS, "ja");
      // Degrades to today's behavior (no CJK matches) instead of throwing.
      expect(await queryOramaIndex(db, "ポイント", 5)).toEqual([]);
      const install = await queryOramaIndex(db, "install", 5);
      expect(install.length).toBe(1);
    } finally {
      intl.Segmenter = original;
    }
  });
});

describe("discovery documents", () => {
  const input = {
    base: "",
    name: "Test Docs",
    route: "/mcp",
    site: "https://docs.example.com",
    version: "0.0.0",
  };

  it("advertises the absolute server URL", () => {
    const discovery = buildMcpDiscovery(input) as {
      servers: { url: string }[];
    };
    expect(discovery.servers[0]?.url).toBe("https://docs.example.com/mcp");
  });

  it("keeps a subpath site's base path in the server URL", () => {
    // new URL("/mcp", "https://acme.com/docs") drops the base; concatenation
    // must keep it, matching how llms.txt builds page URLs.
    const discovery = buildMcpDiscovery({
      ...input,
      site: "https://acme.com/docs",
    }) as { servers: { url: string }[] };
    expect(discovery.servers[0]?.url).toBe("https://acme.com/docs/mcp");
  });

  it("lists the tool set in the server card", () => {
    const card = buildMcpServerCard(input) as { tools: { name: string }[] };
    expect(card.tools.map((tool) => tool.name).toSorted()).toEqual(
      MCP_TOOLS.map((tool) => tool.name).toSorted()
    );
  });

  it("emits the SEP-2127 Server Card core with a reverse-DNS name", () => {
    const card = buildMcpServerCard(input);
    expect(card.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"
    );
    expect(card.name).toBe("com.example.docs/test-docs");
    expect(card.title).toBe("Test Docs");
    expect(card.version).toBe("0.0.0");
    expect(card.websiteUrl).toBe("https://docs.example.com");
    // The schema requires remote URLs to be absolute, so `remotes` appears
    // exactly when a site makes that possible.
    expect(card.remotes).toEqual([
      { type: "streamable-http", url: "https://docs.example.com/mcp" },
    ]);
    expect((card.description as string).length).toBeLessThanOrEqual(100);
  });

  it("carries initialize-shaped compat fields for older scanners", () => {
    const card = buildMcpServerCard(input);
    expect(card.serverInfo).toEqual({ name: "Test Docs", version: "0.0.0" });
    expect(card.capabilities).toEqual({ tools: { listChanged: false } });
    expect(card.transports).toEqual([
      { endpoint: "https://docs.example.com/mcp", type: "streamable-http" },
    ]);
  });

  it("omits remotes and namespaces under localhost without a site", () => {
    const card = buildMcpServerCard({ ...input, site: null });
    expect(card.name).toBe("localhost/test-docs");
    expect(card.remotes).toBeUndefined();
    expect(card.websiteUrl).toBeUndefined();
    // A malformed site keeps the local namespace rather than throwing.
    expect(buildMcpServerCard({ ...input, site: "not a url" }).name).toBe(
      "localhost/test-docs"
    );
  });

  it("caps card text at the schema's 100-character limit", () => {
    const card = buildMcpServerCard({ ...input, name: "N".repeat(120) });
    expect((card.description as string).length).toBe(100);
    expect((card.title as string).length).toBe(100);
    expect((card.description as string).endsWith("…")).toBe(true);
  });

  it("falls back to a relative URL without a site", () => {
    const discovery = buildMcpDiscovery({ ...input, site: null }) as {
      servers: { url: string }[];
    };
    expect(discovery.servers[0]?.url).toBe("/mcp");
  });

  it("layers deployment.base under the advertised URL", () => {
    // The endpoint is a generated Astro page, served under the base.
    const discovery = buildMcpDiscovery({ ...input, base: "/sub" }) as {
      servers: { url: string }[];
    };
    expect(discovery.servers[0]?.url).toBe("https://docs.example.com/sub/mcp");

    const card = buildMcpServerCard({
      ...input,
      base: "/sub",
      site: null,
    }) as { url: string };
    expect(card.url).toBe("/sub/mcp");
  });
});

describe("unknown tool", () => {
  it("reports an error for an unregistered tool name", async () => {
    const { isError, text } = await callTool("bogus_tool");
    expect(isError).toBe(true);
    expect(text).toContain("Unknown tool: bogus_tool");
  });
});

const scanDirs: string[] = [];

const scanFixture = async (
  files: Record<string, string>
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-mcp-"));
  scanDirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return await scanProject(root);
};

afterAll(async () => {
  await Promise.all(
    scanDirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("buildMcpData", () => {
  it("builds a snapshot, honoring config and filtering hidden routes", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { ai: { mcp: { enabled: true, instructions: "Be concise.", name: "Custom MCP" } }, deployment: { base: "sub/", site: "https://docs.example.com" }, title: "Project Title" };',
      "docs/guides/install.md":
        '---\ntitle: Installation\ndescription: How to install\n---\n# Installation\n\nInstall it now.\n\n<Callout type="tip">Use bun.</Callout>\n',
      "docs/index.md":
        "---\ntitle: Home\ndescription: The home page\n---\n# Home\n\nWelcome to the docs.\n",
      "docs/secret.md":
        "---\ntitle: Secret\nsidebar:\n  hidden: true\n---\n# Secret\n\nHidden content.\n",
      "docs/vis.md":
        '---\ntitle: Vis\n---\n# Vis\n\n<Visibility for="web">\nWebonly body.\n</Visibility>\n\n<Visibility for="agents">\nAgentonly body.\n</Visibility>\n',
    });

    const data = await buildMcpData(project);

    // Config-derived metadata: explicit mcp.name/instructions/site win.
    expect(data.name).toBe("Custom MCP");
    expect(data.instructions).toBe("Be concise.");
    expect(data.site).toBe("https://docs.example.com");
    // `deployment.base` is normalized for layering onto base-less routes.
    expect(data.base).toBe("/sub");
    expect(typeof data.version).toBe("string");
    expect(data.version).toBe(project.manifest.blumeVersion);

    // Navigation is passed through from the graph verbatim.
    expect(data.navigation).toBe(project.graph.navigation);

    // Hidden routes are excluded from the route list and search documents.
    const routePaths = data.routes.map((route) => route.route).toSorted();
    expect(routePaths).toStrictEqual(["/", "/guides/install", "/vis"]);
    expect(routePaths).not.toContain("/secret");

    // Route entries carry the page description and a normalized lastModified.
    const install = data.routes.find(
      (route) => route.route === "/guides/install"
    );
    expect(install).toMatchObject({
      contentType: "doc",
      description: "How to install",
      indexable: true,
      lastModified: null,
      title: "Installation",
    });

    // Documents are mapped down to the five MCP fields and skip hidden pages.
    const doc = data.documents.find(
      (entry) => entry.route === "/guides/install"
    );
    expect(doc).toBeDefined();
    expect(Object.keys(doc ?? {}).toSorted()).toStrictEqual([
      "content",
      "contentType",
      "description",
      "route",
      "title",
    ]);
    expect(doc?.contentType).toBe("doc");
    expect(doc?.title).toBe("Installation");
    expect(data.documents.some((entry) => entry.route === "/secret")).toBe(
      false
    );

    // `pages` maps every route (hidden included) to its raw source Markdown,
    // with components downleveled for agents.
    expect(data.pages["/guides/install"]).toContain("# Installation");
    expect(data.pages["/guides/install"]).toContain("title: Installation");
    expect(data.pages["/guides/install"]).toContain("> **Tip**\n>\n> Use bun.");
    expect(data.pages["/guides/install"]).not.toContain("<Callout");
    expect(data.pages["/secret"]).toContain("Hidden content.");

    // Documents are agent-facing: `<Visibility>` resolves like `get_page`
    // (web-only content dropped, agents-only content kept, tags unwrapped).
    const vis = data.documents.find((entry) => entry.route === "/vis");
    expect(vis?.content).toContain("Agentonly body.");
    expect(vis?.content).not.toContain("Webonly body.");
  });

  it("falls back to config.title for the name and null for the site", async () => {
    const project = await scanFixture({
      "blume.config.ts": 'export default { title: "Fallback Title" };',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n\nHi.\n",
    });

    const data = await buildMcpData(project);

    expect(data.name).toBe("Fallback Title");
    expect(data.instructions).toBeUndefined();
    expect(data.site).toBeNull();
    expect(data.base).toBe("");
    // Without i18n there is no default locale to derive a tokenizer from.
    expect(data.defaultLocale).toBeUndefined();
  });

  it("carries i18n.defaultLocale so search_docs can pick a tokenizer", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "ja", locales: [{ code: "ja", label: "日本語" }] }, title: "Docs" };',
      "docs/index.md": "---\ntitle: ホーム\n---\n# ホーム\n\nようこそ。\n",
    });

    const data = await buildMcpData(project);
    expect(data.defaultLocale).toBe("ja");
  });
});
