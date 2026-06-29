import { describe, expect, it } from "bun:test";

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
  buildReferenceFiles,
  referenceTabs,
  resolveReferences,
} from "../src/openapi/scalar.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";

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
  config: Record<string, unknown> = {}
): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://example.com" },
      title: "Docs",
      ...config,
    }),
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
      config,
      contentRoutes: [],
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      needsReact: false,
      pages: [],
      searchClientPath: "/r/.blume/src/generated/search-client.ts",
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(output).toContain('light: "github-light"');
    expect(output).toContain('dark: "github-dark"');
    expect(output).toContain("defaultColor: false");
  });

  const context = {
    outDir: "/r/.blume",
    pagesRoot: null,
    root: "/r",
  } as ProjectContext;
  const configTemplate = (config: ReturnType<typeof blumeConfigSchema.parse>) =>
    astroConfigTemplate({
      config,
      contentRoutes: [],
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      needsReact: false,
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
  it("defaults type to doc and draft to false", () => {
    const meta = pageMetaSchema.parse({});
    expect(meta.type).toBe("doc");
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
      breadcrumbs: [{ label: "Blog", route: "/blog" }, { label: "Post" }],
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
});

describe("api reference (scalar)", () => {
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
        kind: "openapi",
        label: "API Reference",
        route: "/reference",
        spec: "https://example.com/openapi.json",
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

  it("emits both openapi and asyncapi references as nav tabs", () => {
    const config = blumeConfigSchema.parse({
      asyncapi: { enabled: true, spec: "https://x.dev/async.yaml" },
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
    });
    expect(referenceTabs(config)).toStrictEqual([
      { label: "API Reference", path: "/reference" },
      { label: "Events", path: "/events" },
    ]);
  });

  it("declares @scalar/astro only when a reference is enabled", () => {
    const off = blumeConfigSchema.parse({});
    const on = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
    });
    expect(
      runtimeDependencies({ config: off, needsReact: false })
    ).not.toContain("@scalar/astro");
    expect(runtimeDependencies({ config: on, needsReact: false })).toContain(
      "@scalar/astro"
    );
  });

  it("builds a prerendered page passing a remote spec straight through", async () => {
    const config = blumeConfigSchema.parse({
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
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
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
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
      openapi: { enabled: true, spec: "https://x.dev/openapi.json" },
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
