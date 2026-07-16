import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { buildAgentReadability } from "../src/ai/agent-readability.ts";
import {
  astroConfigTemplate,
  runtimeDependencies,
} from "../src/astro/templates.ts";
import {
  findBreadcrumbs,
  flattenPages,
  getPagination,
} from "../src/components/layout/nav-utils.ts";
import { extractHeadings, slugify } from "../src/core/content.ts";
import { buildContentGraph } from "../src/core/graph.ts";
import { buildManifest } from "../src/core/manifest.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { PageRecord, ProjectContext } from "../src/core/types.ts";
import { buildRobots } from "../src/deploy/robots.ts";
import { buildRssFeeds, renderRssFeed } from "../src/deploy/rss.ts";
import { buildSitemap } from "../src/deploy/sitemap.ts";
import {
  referenceRoutes,
  resolveReferences,
} from "../src/openapi/references.ts";
import { buildReferenceFiles } from "../src/openapi/scalar.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import { normalizeXHandle } from "../src/seo/x-handle.ts";

const makePage = (
  over: Pick<PageRecord, "id" | "route" | "title"> & Partial<PageRecord>
): PageRecord => ({
  contentType: "doc",
  format: "mdx",
  groups: [],
  headings: [],
  links: [],
  locale: "",
  meta: pageMetaSchema.parse({}),
  navPath: over.id,
  segments: [],
  source: { name: "filesystem", ref: over.id },
  sourcePath: `/abs/${over.id}`,
  translationKey: over.route,
  ...over,
});

const postPage = (
  id: string,
  route: string,
  type: string,
  meta: Record<string, unknown>
): PageRecord =>
  makePage({
    contentType: type,
    description: `About ${id}`,
    id,
    meta: pageMetaSchema.parse({ type, ...meta }),
    route,
    title: id,
  });

const makeProject = (
  pages: PageRecord[],
  config: Record<string, unknown> = {},
  context: Partial<ProjectContext> = {}
): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://example.com" },
      title: "Docs",
      ...config,
    }),
    context: { pagesRoot: null, ...context },
    graph: { pages },
  }) as unknown as BlumeProject;

const graphOf = (
  data: Record<string, unknown> | null
): Record<string, unknown>[] =>
  (data?.["@graph"] ?? []) as Record<string, unknown>[];

describe("config schema", () => {
  it("applies defaults for an empty config", () => {
    const config = blumeConfigSchema.parse({});
    expect(config.title).toBe("Documentation");
    expect(config.content.root).toBe("docs");
    expect(config.deployment.output).toBe("static");
    expect(config.search.provider).toBe("orama");
  });

  it("rejects unknown top-level keys", () => {
    expect(blumeConfigSchema.safeParse({ nope: true }).success).toBeFalsy();
  });

  it("nests og, rss, and structured data under seo", () => {
    const { seo } = blumeConfigSchema.parse({});
    // Left unset by the schema; loadConfig resolves it against deployment.site.
    expect(seo.og.enabled).toBeUndefined();
    expect(seo.rss.enabled).toBeTruthy();
    expect(seo.rss.types).toStrictEqual(["blog", "changelog"]);
    expect(seo.structuredData).toBeTruthy();
    expect(
      blumeConfigSchema.safeParse({ og: { enabled: true } }).success
    ).toBeFalsy();
  });

  it("accepts Open Graph branding and rejects non-hex palette colors", () => {
    const { og } = blumeConfigSchema.parse({
      seo: {
        og: {
          logo: "/og-logo.svg",
          palette: {
            accent: "#ff5410",
            background: "#1d1d1d",
            border: "#323232",
            foreground: "#fff6f2",
            muted: "#a6a19f",
          },
        },
      },
    }).seo;
    expect(og.logo).toBe("/og-logo.svg");
    expect(og.palette?.background).toBe("#1d1d1d");
    expect(
      blumeConfigSchema.safeParse({
        seo: { og: { palette: { background: "black" } } },
      }).success
    ).toBeFalsy();
  });

  it("normalizes seo.x handles to a leading @", () => {
    // `twitter:site`/`twitter:creator` require the `@`; a handle configured
    // without one is the obvious typo to absorb rather than reject.
    const { seo } = blumeConfigSchema.parse({
      seo: { x: { creator: " @jane ", handle: "acme" } },
    });
    expect(seo.x.handle).toBe("@acme");
    expect(seo.x.creator).toBe("@jane");
    expect(blumeConfigSchema.parse({}).seo.x.handle).toBeUndefined();
    // A blank handle emits no tag rather than a bare "@".
    expect(
      blumeConfigSchema.parse({ seo: { x: { handle: "  " } } }).seo.x.handle
    ).toBeUndefined();
  });

  it("normalizes ai.mcp.route to a leading slash, no trailing slash", () => {
    // A slash-less route would be string-concatenated onto the site origin
    // (`https://acme.comdocs-mcp`) by the well-known/card/agent URLs.
    expect(
      blumeConfigSchema.parse({ ai: { mcp: { route: "docs-mcp" } } }).ai.mcp
        .route
    ).toBe("/docs-mcp");
    expect(
      blumeConfigSchema.parse({ ai: { mcp: { route: "/mcp/" } } }).ai.mcp.route
    ).toBe("/mcp");
    expect(blumeConfigSchema.parse({}).ai.mcp.route).toBe("/mcp");
  });

  it("accepts a banner string or object, defaulting dismissible to false", () => {
    expect(blumeConfigSchema.parse({ banner: "Beta" }).banner).toBe("Beta");
    expect(
      blumeConfigSchema.parse({ banner: { content: "Hi" } }).banner
    ).toStrictEqual({ content: "Hi", dismissible: false });
    expect(
      blumeConfigSchema.safeParse({ banner: { dismissible: true } }).success
    ).toBeFalsy();
  });
});

describe("astro config template", () => {
  it("emits dual light and dark Shiki themes", () => {
    const config = blumeConfigSchema.parse({});
    const context = {
      outDir: "/r/.blume",
      pagesRoot: null,
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      askPath: "/r/.blume/src/generated/Ask.astro",
      config,
      contentRoutes: [],
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      examplesPath: "/r/.blume/src/generated/examples.ts",
      examplesThemePath: "/r/.blume/src/generated/examples.css",
      needsReact: false,
      openapiPath: "/r/.blume/src/generated/openapi.json",
      pages: [],
      searchClientPath: "/r/.blume/src/generated/search-client.ts",
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(output).toContain('light: "github-light"');
    expect(output).toContain('dark: "github-dark"');
    expect(output).toContain("defaultColor: false");
  });

  it("threads a configured codeBlocks theme into shikiConfig and the processors", () => {
    const config = blumeConfigSchema.parse({
      markdown: { codeBlocks: { theme: { dark: "vesper" } } },
    });
    const context = {
      outDir: "/r/.blume",
      pagesRoot: null,
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      askPath: "/r/.blume/src/generated/Ask.astro",
      config,
      contentRoutes: [],
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      examplesPath: "/r/.blume/src/generated/examples.ts",
      examplesThemePath: "/r/.blume/src/generated/examples.css",
      needsReact: false,
      openapiPath: "/r/.blume/src/generated/openapi.json",
      pages: [],
      searchClientPath: "/r/.blume/src/generated/search-client.ts",
      themePath: "/r/.blume/src/generated/app.css",
    });

    // Fenced code (the reported bug): the dark override reaches shikiConfig while
    // the unset light theme keeps its github default.
    expect(output).toContain('dark: "vesper"');
    expect(output).toContain('light: "github-light"');
    // Inline code shares the theme via the processor's `codeThemes` option.
    expect(output).toContain(
      '"codeThemes":{"dark":"vesper","light":"github-light"}'
    );
  });

  const context = {
    outDir: "/r/.blume",
    pagesRoot: null,
    root: "/r",
  } as ProjectContext;
  const configTemplate = (config: ReturnType<typeof blumeConfigSchema.parse>) =>
    astroConfigTemplate({
      askPath: "/r/.blume/src/generated/Ask.astro",
      config,
      contentRoutes: [],
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      examplesPath: "/r/.blume/src/generated/examples.ts",
      examplesThemePath: "/r/.blume/src/generated/examples.css",
      needsReact: false,
      openapiPath: "/r/.blume/src/generated/openapi.json",
      pages: [],
      searchClientPath: "/r/.blume/src/generated/search-client.ts",
      themePath: "/r/.blume/src/generated/app.css",
    });

  it("emits the self-hosted default fonts when theme.fonts is omitted", () => {
    const output = configTemplate(blumeConfigSchema.parse({}));
    expect(output).toContain(
      'import { defineConfig, fontProviders } from "astro/config";'
    );
    expect(output).toContain("provider: fontProviders.google()");
    expect(output).toContain('name: "Inter Tight"');
    expect(output).toContain('name: "Inter"');
    expect(output).toContain('cssVariable: "--blume-ff-ibm-plex-mono"');
  });

  it("emits an overridden font role alongside the defaults", () => {
    const output = configTemplate(
      blumeConfigSchema.parse({ theme: { fonts: { body: "geist" } } })
    );
    expect(output).toContain('name: "Geist"');
    expect(output).toContain('name: "Inter Tight"');
    expect(output).toContain('cssVariable: "--blume-ff-ibm-plex-mono"');
  });

  it("always wires Twoslash in with an explicit per-block trigger", () => {
    const output = configTemplate(blumeConfigSchema.parse({}));
    expect(output).toContain(
      'import { transformerTwoslash } from "@shikijs/twoslash"'
    );
    expect(output).toContain("transformerTwoslash({ explicitTrigger: true })");
  });
});

describe("page meta schema", () => {
  it("leaves type unset (deferred to content.defaultType) and defaults draft to false", () => {
    const meta = pageMetaSchema.parse({});
    // No schema default: normalizeEntry falls back to `content.defaultType`.
    expect(meta.type).toBeUndefined();
    expect(meta.draft).toBeFalsy();
    expect(meta.sidebar.hidden).toBeFalsy();
  });
});

describe(slugify, () => {
  it("produces github-style slugs", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Spaced  Out  ")).toBe("spaced-out");
  });
});

describe(extractHeadings, () => {
  it("extracts headings and skips fenced code", () => {
    const body = ["# Title", "```", "## Not a heading", "```", "## Real"].join(
      "\n"
    );
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.text)).toStrictEqual(["Title", "Real"]);
  });

  it("skips headings inside tilde-fenced code", () => {
    const body = ["# Title", "~~~", "## Not a heading", "~~~", "## Real"].join(
      "\n"
    );
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual([
      "Title",
      "Real",
    ]);
  });

  it("keeps a ``` line inside a ~~~ fence from toggling the fence state", () => {
    // A tilde fence showing a backtick-fenced snippet: the inner ``` lines are
    // content, so `## Shown` stays fenced and only `## After` is a heading.
    const body = ["~~~md", "```", "## Shown", "```", "~~~", "## After"].join(
      "\n"
    );
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual(["After"]);
  });

  it("keeps a trailing # that is part of the heading text", () => {
    const body = ["## What is C#", "## Setup ##"].join("\n");
    // A closing hash sequence needs preceding whitespace (CommonMark); a bare
    // trailing `#` is heading text.
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual([
      "What is C#",
      "Setup",
    ]);
  });

  it("extracts ATX headings indented up to three spaces, not four", () => {
    // CommonMark (and the renderer) accepts 1-3 leading spaces; 4 is an
    // indented code block.
    const body = ["   ## Indented", "    # Code block"].join("\n");
    expect(extractHeadings(body)).toStrictEqual([
      { depth: 2, slug: "indented", text: "Indented" },
    ]);
  });

  it("extracts setext headings at levels 1 (=) and 2 (-)", () => {
    const body = ["Title", "=====", "", "Section", "  ---"].join("\n");
    expect(extractHeadings(body)).toStrictEqual([
      { depth: 1, slug: "title", text: "Title" },
      { depth: 2, slug: "section", text: "Section" },
    ]);
  });

  it("joins a multi-line paragraph into one setext heading", () => {
    const body = ["Long", "title", "===="].join("\n");
    expect(extractHeadings(body)).toStrictEqual([
      { depth: 1, slug: "long-title", text: "Long title" },
    ]);
  });

  it("does not misread front matter, breaks, lists, or tables as setext", () => {
    const body = [
      "---",
      "title: Foo",
      "---",
      "",
      "Intro paragraph.",
      "",
      "---",
      "",
      "- item",
      "---",
      "> quote",
      "===",
      "| a |",
      "| --- |",
    ].join("\n");
    // Front matter delimiters, a thematic break after a blank line, a break
    // closing a list or blockquote, and a table delimiter row are all
    // underline look-alikes that must not produce headings.
    expect(extractHeadings(body)).toStrictEqual([]);
  });

  it("keeps setext underlines inside fenced code as content", () => {
    const body = ["```", "yaml", "----", "```", "Real", "----"].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual(["Real"]);
  });

  it("slugs anchors like the renderer: keeps `--` and disambiguates dupes", () => {
    const body = ["## The read & write fallback", "## Setup", "## Setup"].join(
      "\n"
    );
    // A hand slugify would collapse `--` and repeat `setup`, mismatching the
    // github-slugger ids the renderer emits — the source of validate's false
    // "broken anchor" reports.
    expect(extractHeadings(body).map((h) => h.slug)).toStrictEqual([
      "the-read--write-fallback",
      "setup",
      "setup-1",
    ]);
  });

  it("skips headings inside <Prompt> — its children render into a hidden node", () => {
    const body = [
      "# Title",
      "<Prompt",
      '  description="Copy this"',
      '  actions={["copy"]}',
      ">",
      "## Setup",
      "## Never do",
      "</Prompt>",
      "## Real",
    ].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual([
      "Title",
      "Real",
    ]);
  });

  it("does not treat a self-closing <Prompt /> as opening a hidden region", () => {
    const body = ['<Prompt description="x" />', "## Real"].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual(["Real"]);
  });

  it("does not match <PromptCard> as the Prompt component", () => {
    const body = ["<PromptCard>", "## Still a heading", "</PromptCard>"].join(
      "\n"
    );
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual([
      "Still a heading",
    ]);
  });

  it("does not treat a multi-line self-closing <Prompt /> as opening a hidden region", () => {
    const body = ["<Prompt", '  description="x"', "/>", "## Real"].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual(["Real"]);
  });

  it("ignores a `<Prompt>` mention in prose — only a tag starting a line opens a hidden region", () => {
    const body = ["Use the `<Prompt>` component.", "", "## Real"].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual(["Real"]);
  });

  it("keeps a heading whose text mentions <Prompt>", () => {
    const body = ["## The <Prompt> component", "## After"].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual([
      "The <Prompt> component",
      "After",
    ]);
  });

  it("handles a <Prompt> that opens and closes on one line", () => {
    const body = [
      '<Prompt description="x">Copy this.</Prompt>',
      "## Real",
    ].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual(["Real"]);
  });

  it("handles a close tag trailing the prompt's children text", () => {
    const body = [
      "<Prompt>",
      "## Hidden",
      "Copy this.</Prompt>",
      "## Real",
    ].join("\n");
    expect(extractHeadings(body).map((h) => h.text)).toStrictEqual(["Real"]);
  });
});

describe("content graph", () => {
  it("flags duplicate routes", () => {
    const graph = buildContentGraph(
      [
        makePage({ id: "a.mdx", route: "/x", title: "A" }),
        makePage({ id: "b.mdx", route: "/x", title: "B" }),
      ],
      {
        folderMeta: new Map(),
        navigation: blumeConfigSchema.parse({}).navigation,
      }
    );
    expect(
      graph.diagnostics.some((d) => d.code === "BLUME_DUPLICATE_ROUTE")
    ).toBeTruthy();
  });
});

describe("manifest indexability", () => {
  const context = { contentRoot: "/c", root: "/r" } as ProjectContext;

  it("indexes pages by default and respects search.exclude", () => {
    const config = blumeConfigSchema.parse({});
    const pages = [
      makePage({ id: "a.mdx", route: "/a", title: "A" }),
      makePage({
        id: "b.mdx",
        meta: pageMetaSchema.parse({ search: { exclude: true } }),
        route: "/b",
        title: "B",
      }),
    ];
    const graph = buildContentGraph(pages, {
      folderMeta: new Map(),
      navigation: config.navigation,
    });
    const manifest = buildManifest({ config, context, graph });
    const byPath = new Map(manifest.routes.map((r) => [r.path, r.indexable]));
    expect(byPath.get("/a")).toBeTruthy();
    expect(byPath.get("/b")).toBeFalsy();
  });
});

describe("nav utilities", () => {
  const sidebar = [
    { kind: "page" as const, label: "Home", pageId: "i", route: "/" },
    {
      children: [
        {
          kind: "page" as const,
          label: "Deploy",
          pageId: "d",
          route: "/g/deploy",
        },
      ],
      kind: "group" as const,
      label: "Guides",
    },
  ];

  it("flattens pages in order", () => {
    expect(flattenPages(sidebar).map((p) => p.route)).toStrictEqual([
      "/",
      "/g/deploy",
    ]);
  });

  it("builds breadcrumb trails", () => {
    expect(
      findBreadcrumbs(sidebar, "/g/deploy").map((c) => c.label)
    ).toStrictEqual(["Guides", "Deploy"]);
  });

  it("resolves previous/next", () => {
    const flat = flattenPages(sidebar);
    expect(getPagination(flat, "/").next?.route).toBe("/g/deploy");
    expect(getPagination(flat, "/g/deploy").prev?.route).toBe("/");
  });
});

describe("rss feeds", () => {
  it("returns no feeds without a configured site", () => {
    const pages = [postPage("a", "/blog/a", "blog", { date: "2026-01-01" })];
    expect(buildRssFeeds(makeProject(pages, { deployment: {} }))).toStrictEqual(
      []
    );
  });

  it("returns no feeds when disabled", () => {
    const pages = [postPage("a", "/blog/a", "blog", { date: "2026-01-01" })];
    expect(
      buildRssFeeds(makeProject(pages, { seo: { rss: { enabled: false } } }))
    ).toStrictEqual([]);
  });

  it("builds a feed per content type with matching pages", () => {
    const pages = [
      postPage("doc", "/guide", "doc", {}),
      postPage("post", "/blog/post", "blog", { date: "2026-01-01" }),
      postPage("v1", "/changelog/v1", "changelog", {
        changelog: { date: "2026-02-01" },
      }),
    ];
    const feeds = buildRssFeeds(makeProject(pages));
    expect(feeds.map((f) => f.path)).toStrictEqual([
      "/blog/rss.xml",
      "/changelog/rss.xml",
    ]);
    expect(feeds[0]?.title).toBe("Docs — Blog");
  });

  it("sorts items newest-first and honors the limit", () => {
    const pages = [
      postPage("old", "/blog/old", "blog", { date: "2026-01-01" }),
      postPage("new", "/blog/new", "blog", { date: "2026-03-01" }),
      postPage("mid", "/blog/mid", "blog", { date: "2026-02-01" }),
    ];
    const [feed] = buildRssFeeds(
      makeProject(pages, { seo: { rss: { limit: 2 } } })
    );
    expect(feed?.items.map((i) => i.title)).toStrictEqual(["new", "mid"]);
  });

  it("excludes drafts and hidden pages", () => {
    const pages = [
      postPage("draft", "/blog/draft", "blog", {
        date: "2026-01-01",
        draft: true,
      }),
      postPage("hidden", "/blog/hidden", "blog", {
        date: "2026-01-02",
        sidebar: { hidden: true },
      }),
      postPage("live", "/blog/live", "blog", { date: "2026-01-03" }),
    ];
    const [feed] = buildRssFeeds(makeProject(pages));
    expect(feed?.items.map((i) => i.title)).toStrictEqual(["live"]);
  });

  it("renders escaped RSS 2.0 XML with absolute links and pubDate", () => {
    const pages = [
      postPage("Tom & Jerry", "/blog/post", "blog", { date: "2026-01-01" }),
    ];
    const [feed] = buildRssFeeds(makeProject(pages));
    const xml = renderRssFeed(feed as NonNullable<typeof feed>);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<title>Tom &amp; Jerry</title>");
    expect(xml).toContain("<link>https://example.com/blog/post</link>");
    expect(xml).toContain("<pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>");
    expect(xml).toContain(
      '<atom:link href="https://example.com/blog/rss.xml" rel="self"'
    );
  });

  it("URI-encodes item links like the sitemap does", () => {
    const pages = [
      postPage("Tips", "/tips & tricks/café", "blog", { date: "2026-01-01" }),
    ];
    const [feed] = buildRssFeeds(makeProject(pages));
    // A raw space or non-ASCII character in <link>/<guid> is an invalid URL
    // for feed readers; the route must be percent-encoded.
    expect(feed?.items[0]?.link).toBe(
      "https://example.com/tips%20&%20tricks/caf%C3%A9"
    );
  });
});

describe("structured data", () => {
  it("emits only a WebSite node for the homepage", () => {
    const data = buildStructuredData({
      breadcrumbs: [],
      route: "/",
      siteName: "Docs",
      siteUrl: "https://x.com",
      title: "Home",
    });
    expect(graphOf(data).map((n) => n["@type"])).toStrictEqual(["WebSite"]);
  });

  it("emits a BlogPosting with absolute url, datePublished, and breadcrumbs", () => {
    const data = buildStructuredData({
      breadcrumbs: [
        { label: "Blog", route: "/blog" },
        { label: "Post", route: "/blog/post" },
      ],
      description: "Hi",
      pageType: "blog",
      published: "2026-01-01",
      route: "/blog/post",
      siteName: "Docs",
      siteUrl: "https://x.com/",
      title: "Post",
    });
    const graph = graphOf(data);
    const article = graph.find((n) => n["@type"] === "BlogPosting");
    expect(article?.url).toBe("https://x.com/blog/post");
    expect(article?.datePublished).toBe("2026-01-01T00:00:00.000Z");
    expect(article?.isPartOf).toStrictEqual({ "@id": "https://x.com#website" });
    expect(graph.some((n) => n["@type"] === "BreadcrumbList")).toBeTruthy();
  });

  it("drops route-less group crumbs and renumbers positions", () => {
    // A sidebar group without an index page yields a crumb with no route;
    // Google requires `item` on every position except the last, so those
    // crumbs must not appear as link-less ListItems.
    const data = buildStructuredData({
      breadcrumbs: [
        { label: "Guides" },
        { label: "Advanced", route: "/guides/advanced" },
        { label: "Deep", route: "/guides/advanced/deep" },
      ],
      route: "/guides/advanced/deep",
      siteName: "Docs",
      siteUrl: "https://x.com",
      title: "Deep",
    });
    const list = graphOf(data).find((n) => n["@type"] === "BreadcrumbList");
    expect(list?.itemListElement).toStrictEqual([
      {
        "@type": "ListItem",
        item: "https://x.com/guides/advanced",
        name: "Advanced",
        position: 1,
      },
      {
        "@type": "ListItem",
        item: "https://x.com/guides/advanced/deep",
        name: "Deep",
        position: 2,
      },
    ]);
  });

  it("omits the BreadcrumbList when fewer than two crumbs have routes", () => {
    const data = buildStructuredData({
      breadcrumbs: [{ label: "Group" }, { label: "Page", route: "/page" }],
      route: "/page",
      siteName: "Docs",
      siteUrl: "https://x.com",
      title: "Page",
    });
    expect(
      graphOf(data).some((n) => n["@type"] === "BreadcrumbList")
    ).toBeFalsy();
  });

  it("falls back to relative urls and TechArticle without a site", () => {
    const data = buildStructuredData({
      breadcrumbs: [],
      route: "/guide",
      siteName: "Docs",
      siteUrl: null,
      title: "Guide",
    });
    const graph = graphOf(data);
    expect(graph.map((n) => n["@type"])).toStrictEqual(["TechArticle"]);
    expect(graph[0]?.url).toBe("/guide");
  });

  it("returns null for the homepage without a site", () => {
    expect(
      buildStructuredData({
        breadcrumbs: [],
        route: "/",
        siteName: "Docs",
        siteUrl: null,
        title: "Home",
      })
    ).toBeNull();
  });
});

describe("sitemap", () => {
  it("excludes drafts, hidden, and noindex pages", () => {
    const pages = [
      makePage({ id: "a", route: "/a", title: "A" }),
      makePage({
        id: "b",
        meta: pageMetaSchema.parse({ draft: true }),
        route: "/b",
        title: "B",
      }),
      makePage({
        id: "c",
        meta: pageMetaSchema.parse({ sidebar: { hidden: true } }),
        route: "/c",
        title: "C",
      }),
      makePage({
        id: "d",
        meta: pageMetaSchema.parse({ seo: { noindex: true } }),
        route: "/d",
        title: "D",
      }),
    ];
    const xml = buildSitemap(makeProject(pages)) ?? "";
    expect(xml).toContain("https://example.com/a");
    expect(xml).not.toContain("/b<");
    expect(xml).not.toContain("/c<");
    expect(xml).not.toContain("/d<");
  });

  it("returns null without a site or when disabled", () => {
    const pages = [makePage({ id: "a", route: "/a", title: "A" })];
    expect(buildSitemap(makeProject(pages, { deployment: {} }))).toBeNull();
    expect(
      buildSitemap(makeProject(pages, { seo: { sitemap: false } }))
    ).toBeNull();
  });

  it("escapes and encodes routes so the XML stays well-formed", () => {
    const pages = [makePage({ id: "a", route: "/Tips & Tricks", title: "T" })];
    const xml = buildSitemap(makeProject(pages)) ?? "";
    // `&` must be entity-escaped and the space percent-encoded.
    expect(xml).toContain(
      "<loc>https://example.com/Tips%20&amp;%20Tricks</loc>"
    );
    expect(xml).not.toContain("Tips & Tricks");
  });

  it("adds a <lastmod> for a page with a modified date", () => {
    const pages = [
      makePage({
        id: "a",
        lastModified: "2024-05-01T10:00:00Z",
        route: "/a",
        title: "A",
      }),
      makePage({ id: "b", route: "/b", title: "B" }),
    ];
    const xml = buildSitemap(makeProject(pages)) ?? "";
    expect(xml).toContain("<lastmod>2024-05-01</lastmod>");
    // A page without a date gets a plain <url> with no lastmod.
    expect(xml).toContain("<loc>https://example.com/b</loc></url>");
  });
});

describe("sitemap — custom pages and generated routes", () => {
  let pagesRoot: string;

  beforeAll(async () => {
    pagesRoot = await mkdtemp(join(tmpdir(), "blume-sitemap-pages-"));
    await mkdir(join(pagesRoot, "blog"), { recursive: true });
    await Promise.all([
      writeFile(join(pagesRoot, "index.astro"), "<h1>home</h1>"),
      writeFile(join(pagesRoot, "about.astro"), "<h1>about</h1>"),
      writeFile(join(pagesRoot, "blog", "[slug].astro"), "<h1>post</h1>"),
      writeFile(join(pagesRoot, "_partial.astro"), "<h1>private</h1>"),
      writeFile(join(pagesRoot, "404.astro"), "<h1>not found</h1>"),
      writeFile(join(pagesRoot, "500.astro"), "<h1>error</h1>"),
    ]);
  });

  afterAll(async () => {
    await rm(pagesRoot, { force: true, recursive: true });
  });

  it("includes static custom pages, skipping dynamic and private ones", () => {
    const pages = [makePage({ id: "a", route: "/a", title: "A" })];
    const xml = buildSitemap(makeProject(pages, {}, { pagesRoot })) ?? "";
    // The custom landing page is the most important shared URL on the site.
    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).not.toContain("slug");
    expect(xml).not.toContain("_partial");
  });

  it("omits user-authored 404/500 error pages", () => {
    const pages = [makePage({ id: "nf", route: "/404", title: "Not Found" })];
    const xml = buildSitemap(makeProject(pages, {}, { pagesRoot })) ?? "";
    // Neither the custom `.astro` error pages nor a `404.md` content override
    // is a crawlable destination.
    expect(xml).not.toContain("/404");
    expect(xml).not.toContain("/500");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
  });

  it("emits a single entry when a custom page and a content route collide", () => {
    const pages = [makePage({ id: "about", route: "/about", title: "About" })];
    const xml = buildSitemap(makeProject(pages, {}, { pagesRoot })) ?? "";
    const occurrences = xml.split("<loc>https://example.com/about</loc>");
    expect(occurrences).toHaveLength(2);
  });

  it("layers the deployment base onto custom-page URLs", () => {
    const xml =
      buildSitemap(
        makeProject(
          [],
          { deployment: { base: "/base", site: "https://example.com" } },
          { pagesRoot }
        )
      ) ?? "";
    expect(xml).toContain("<loc>https://example.com/base/about</loc>");
  });

  it("includes the generated /changelog index when it exists", () => {
    const pages = [
      postPage("v1", "/changelog/v1", "changelog", { date: "2024-01-01" }),
    ];
    const xml = buildSitemap(makeProject(pages)) ?? "";
    expect(xml).toContain("<loc>https://example.com/changelog</loc>");
  });

  it("omits /changelog when a content page already owns the route", () => {
    const pages = [postPage("cl", "/changelog", "changelog", {})];
    const xml = buildSitemap(makeProject(pages)) ?? "";
    const occurrences = xml.split("<loc>https://example.com/changelog</loc>");
    expect(occurrences).toHaveLength(2);
  });
});

describe("x handles", () => {
  it("adds the @ a twitter:site/creator tag needs", () => {
    expect(normalizeXHandle("acme")).toBe("@acme");
    expect(normalizeXHandle("@acme")).toBe("@acme");
    expect(normalizeXHandle("  @acme  ")).toBe("@acme");
  });

  it("drops a handle with nothing in it", () => {
    // `unset` is the unconfigured `seo.x.handle` the layouts pass through.
    const unset: string | undefined = undefined;
    expect(normalizeXHandle("")).toBeUndefined();
    expect(normalizeXHandle("   ")).toBeUndefined();
    expect(normalizeXHandle("@")).toBeUndefined();
    expect(normalizeXHandle(unset)).toBeUndefined();
  });

  it("drops a non-string handle instead of rendering one", () => {
    // The layouts normalize raw frontmatter (`seo.x.creator`), which Astro's
    // collections don't type-check — `creator: 12345` reaches them as a number.
    expect(normalizeXHandle(12_345)).toBeUndefined();
    expect(normalizeXHandle({ handle: "@acme" })).toBeUndefined();
  });
});

describe("robots.txt", () => {
  it("allows all crawlers and links the sitemap when a site is set", () => {
    const robots = buildRobots(makeProject([])) ?? "";
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("omits the sitemap line without a site", () => {
    const robots = buildRobots(makeProject([], { deployment: {} })) ?? "";
    expect(robots).toContain("User-agent: *");
    expect(robots).not.toContain("Sitemap:");
  });

  it("returns null when disabled", () => {
    expect(buildRobots(makeProject([], { seo: { robots: false } }))).toBeNull();
  });

  it("declares every Content-Signal as yes by default", () => {
    const robots = buildRobots(makeProject([])) ?? "";
    expect(robots).toContain(
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes"
    );
  });

  it("restricts an individual signal while leaving the rest yes", () => {
    const robots =
      buildRobots(
        makeProject([], { seo: { contentSignals: { aiTrain: false } } })
      ) ?? "";
    expect(robots).toContain(
      "Content-Signal: search=yes, ai-input=yes, ai-train=no"
    );
  });

  it("omits the Content-Signal line when disabled with false", () => {
    const robots =
      buildRobots(makeProject([], { seo: { contentSignals: false } })) ?? "";
    expect(robots).toContain("User-agent: *");
    expect(robots).not.toContain("Content-Signal:");
  });
});

describe("agent-readability.json", () => {
  it("indexes the Markdown mirror and sitemap with absolute URLs", () => {
    const manifest = buildAgentReadability(makeProject([]));
    expect(manifest?.name).toBe("Docs");
    expect(manifest?.site).toBe("https://example.com");
    expect(manifest?.artifacts).toMatchObject({
      markdown: {
        contentNegotiation: "text/markdown",
        pattern: "https://example.com/{route}.md",
      },
      sitemap: "https://example.com/sitemap.xml",
    });
  });

  it("returns null when disabled", () => {
    expect(
      buildAgentReadability(
        makeProject([], { seo: { agentReadability: false } })
      )
    ).toBeNull();
  });

  it("advertises llms.txt, MCP, Ask AI, feeds, and content usage when configured", () => {
    const manifest = buildAgentReadability(
      makeProject([postPage("changes", "/blog/changes", "blog", {})], {
        ai: { ask: { enabled: true }, llmsTxt: true, mcp: { enabled: true } },
        github: { owner: "inthhq", repo: "leadtype" },
        seo: { contentSignals: { aiTrain: false, search: true } },
      })
    );
    expect(manifest?.artifacts).toMatchObject({
      askApi: "https://example.com/api/ask",
      feeds: ["https://example.com/blog/rss.xml"],
      llmsFullTxt: "https://example.com/llms-full.txt",
      llmsTxt: "https://example.com/llms.txt",
      mcp: {
        discovery: "https://example.com/.well-known/mcp.json",
        url: "https://example.com/mcp",
      },
    });
    expect(manifest?.contentUsage).toStrictEqual({
      "ai-input": true,
      "ai-train": false,
      search: true,
    });
    expect(manifest?.repository).toBe("https://github.com/inthhq/leadtype");
  });

  it("echoes the content-usage policy by default and drops it when disabled", () => {
    const on = buildAgentReadability(makeProject([]));
    expect(on?.contentUsage).toStrictEqual({
      "ai-input": true,
      "ai-train": true,
      search: true,
    });
    const off = buildAgentReadability(
      makeProject([], { seo: { contentSignals: false } })
    );
    expect(off?.contentUsage).toBeUndefined();
  });

  it("uses root-relative URLs and omits the sitemap without a site", () => {
    const manifest = buildAgentReadability(
      makeProject([], { ai: { llmsTxt: true }, deployment: {} })
    );
    const artifacts = (manifest?.artifacts ?? {}) as Record<string, unknown>;
    expect(manifest?.site).toBeNull();
    expect(artifacts).toMatchObject({
      llmsTxt: "/llms.txt",
      markdown: { pattern: "/{route}.md" },
    });
    expect(artifacts.sitemap).toBeUndefined();
  });

  it("layers deployment.base onto root-relative URLs without a site", () => {
    const manifest = buildAgentReadability(
      makeProject([], {
        ai: { ask: { enabled: true }, llmsTxt: true, mcp: { enabled: true } },
        deployment: { base: "/docs" },
      })
    );
    // Without a site the artifacts are still served under the base subpath, so
    // bare root-relative paths (`/llms.txt`) would 404 (the mcp.json convention).
    expect(manifest?.artifacts).toMatchObject({
      askApi: "/docs/api/ask",
      llmsFullTxt: "/docs/llms-full.txt",
      llmsTxt: "/docs/llms.txt",
      markdown: { pattern: "/docs/{route}.md" },
      mcp: {
        discovery: "/docs/.well-known/mcp.json",
        url: "/docs/mcp",
      },
    });
  });
});

describe("api reference (scalar)", () => {
  it("defaults navigation tabs to an empty array and preserves configured ones", () => {
    expect(blumeConfigSchema.parse({}).navigation.tabs).toStrictEqual([]);
    const config = blumeConfigSchema.parse({
      navigation: { tabs: [{ label: "Docs", path: "/docs" }] },
    });
    expect(config.navigation.tabs).toStrictEqual([
      { label: "Docs", path: "/docs" },
    ]);
  });

  it("defaults openapi and asyncapi to disabled with sensible routes", () => {
    const config = blumeConfigSchema.parse({});
    expect(config.openapi.enabled).toBeFalsy();
    expect(config.openapi.route).toBe("/reference");
    expect(config.asyncapi.enabled).toBeFalsy();
    expect(config.asyncapi.route).toBe("/events");
    expect(resolveReferences(config)).toStrictEqual([]);
  });

  it("treats the spec shorthand as a single source at the base route", () => {
    const config = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "https://example.com/openapi.json" },
    });
    expect(resolveReferences(config)).toStrictEqual([
      {
        basePath: "",
        display: {
          codeSamples: ["curl", "js", "python"],
          expandSchemas: false,
        },
        kind: "openapi",
        label: "API Reference",
        renderer: "blume",
        route: "/reference",
        slug: "reference",
        spec: "https://example.com/openapi.json",
        // toStrictEqual requires the `theme` key present and undefined; null
        // would change what the resolved reference is asserted to be.
        // oxlint-disable-next-line sonarjs/no-undefined-assignment
        theme: undefined,
      },
    ]);
  });

  it("derives one route per source and honors explicit routes", () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        sources: [
          { label: "Public API", spec: "https://x.dev/public.json" },
          { route: "/admin", spec: "https://x.dev/admin.json" },
        ],
      },
    });
    const routes = resolveReferences(config).map((ref) => ref.route);
    expect(routes).toStrictEqual(["/reference/public-api", "/admin"]);
  });

  it("exposes both openapi and asyncapi reference routes as nav targets", () => {
    const config = blumeConfigSchema.parse({
      asyncapi: { enabled: true, spec: "https://x.dev/async.yaml" },
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
    });
    expect(referenceRoutes(config)).toStrictEqual(["/reference", "/events"]);
  });

  it("declares @scalar/astro only for a Scalar-rendered reference", () => {
    const off = blumeConfigSchema.parse({});
    // The default Blume renderer parses at generate time and needs no dep.
    const blume = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
    });
    const scalar = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
      },
    });
    expect(
      runtimeDependencies({ config: off, needsReact: false })
    ).not.toContain("@scalar/astro");
    expect(
      runtimeDependencies({ config: blume, needsReact: false })
    ).not.toContain("@scalar/astro");
    expect(
      runtimeDependencies({ config: scalar, needsReact: false })
    ).toContain("@scalar/astro");
  });

  it("skips a Scalar page for a Blume-rendered reference", async () => {
    const config = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
    });
    const { files } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    expect(files).toStrictEqual([]);
  });

  it("builds a prerendered page passing a remote spec straight through", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
      },
      theme: { accent: "teal" },
    });
    const { files, warnings } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    const [page] = files;
    expect(warnings).toStrictEqual([]);
    expect(files).toHaveLength(1);
    expect(page?.pagePath).toBe("reference.astro");
  });

  it("emits a prerendered Scalar page with the spec url and theme accent", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
      },
      theme: { accent: "teal" },
    });
    const { files } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(),
      root: "/r",
    });
    const [page] = files;
    expect(page?.content).toContain("export const prerender = true");
    expect(page?.content).toContain('"url": "https://x.dev/openapi.json"');
    expect(page?.content).toContain("--scalar-color-accent");
  });

  it("skips a reference whose route collides with a content page", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "https://x.dev/openapi.json",
      },
    });
    const { files, warnings } = await buildReferenceFiles({
      config,
      contentRoutes: new Set(["/reference"]),
      root: "/r",
    });
    expect(files).toStrictEqual([]);
    expect(warnings[0]).toContain("collides with a content page");
  });
});
