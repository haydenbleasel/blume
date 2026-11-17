import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildFeedMarkdown } from "../src/ai/markdown.ts";
import { buildSiteSkill } from "../src/ai/site-skill.ts";
import { ogEndpointTemplate } from "../src/astro/templates.ts";
import { directoryEntries } from "../src/components/layout/nav-utils.ts";
import type { NavGroup } from "../src/components/layout/nav-utils.ts";
import { blogPosts } from "../src/core/blog-posts.ts";
import {
  compareChangelogDates,
  groupChangelogYears,
  parseChangelogDate,
} from "../src/core/changelog-list.ts";
import { entryDate } from "../src/core/dated-list.ts";
import { validateLinks } from "../src/core/links.ts";
import { buildNavigation } from "../src/core/navigation.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import {
  blumeConfigSchema,
  pageCollectionSchema,
  pageMetaSchema,
} from "../src/core/schema.ts";
import type { PageMetaInput } from "../src/core/schema.ts";
import { withoutJsxComments } from "../src/core/sources/normalize.ts";
import { obsidianSource } from "../src/core/sources/obsidian.ts";
import type { NavNode, PageRecord } from "../src/core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../src/deploy/rss.ts";
import type { RssFeed } from "../src/deploy/rss.ts";
import { cardCacheKey } from "../src/og/cache.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";

/**
 * The blog alongside what sites already had: front matter keys a site
 * declared itself, Obsidian vaults, git dates, hand-ordered and year-foldered
 * posts, directories, translations, and a feed carrying whole pages.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const write = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-blog-compat-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const scanFixture = async (
  files: Record<string, string>
): Promise<BlumeProject> => await scanProject(await write(files));

// SAFETY: only the fields the sidebar builder reads; the rest of PageRecord
// is immaterial to it.
const page = (
  navPath: string,
  meta: PageMetaInput,
  extra: Partial<PageRecord> = {}
): PageRecord =>
  ({
    anchors: [],
    contentType: meta.type ?? "doc",
    format: "md",
    groups: [],
    headings: [],
    id: navPath,
    links: [],
    locale: "",
    meta: pageMetaSchema.parse(meta),
    navPath,
    route: `/${navPath.replace(/\.md$/u, "")}`,
    segments: [],
    source: { name: "filesystem", ref: navPath },
    title: meta.title ?? navPath,
    translationKey: navPath,
    version: "",
    versionKey: navPath,
    ...extra,
  }) as PageRecord;

/** A card's cache key with `dir/c.png` as its cover. */
const coverKey = (dir: string) =>
  cardCacheKey("1.0.0", { article: { cover: join(dir, "c.png") }, title: "T" });

/** Labels, a group as `{ label: children }`. */
const outline = (nodes: NavNode[]): unknown[] =>
  nodes.map((node) =>
    node.kind === "page" ? node.label : { [node.label]: outline(node.children) }
  );

describe("front matter a site already declared", () => {
  it("carries a site's own cover and tags in its content entry as written", () => {
    const data = pageCollectionSchema.parse({
      cover: { image: "x.png" },
      description: "Kept.",
      seo: { noindex: true },
      tags: [{ label: "a", permalink: "/a" }],
      title: "A",
    });
    expect(data).toMatchObject({
      description: "Kept.",
      seo: { noindex: true },
      title: "A",
    });
    // A custom page reading `entry.data` gets the site's own values back.
    expect(data.cover).toEqual({ image: "x.png" });
    expect(data.tags).toEqual([{ label: "a", permalink: "/a" }]);
  });

  it("keeps a site's own `tags` and `cover`, which the blog then doesn't read", async () => {
    const project = await scanFixture({
      // Standard Schemas that take any value as it is.
      "blume.config.ts": [
        'const any = { "~standard": { validate: (value) => ({ value }), vendor: "test", version: 1 } };',
        "export default {",
        "  frontmatter: { extend: { tags: any } },",
        '  content: { types: { blog: { facets: ["tags"], frontmatter: { cover: any } } } },',
        "};",
        "",
      ].join("\n"),
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ntags: one string\ncover: 3\n---\n\nBody.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const post = project.graph.pages.find((entry) => entry.route === "/blog/a");
    expect(post?.custom).toStrictEqual({ cover: 3, tags: "one string" });
    expect(post?.meta.tags).toBeUndefined();
    expect(blogPosts(project)[0]).toMatchObject({ cover: null, tags: [] });
  });

  it("still refuses to redeclare a load-bearing key", () => {
    const result = blumeConfigSchema.safeParse({
      frontmatter: { extend: { title: { "~standard": {} } } },
    });
    expect(result.success).toBe(false);
  });

  it("takes a single tag without a list, and a number as its digits", () => {
    expect(pageMetaSchema.parse({ tags: "go" }).tags).toStrictEqual(["go"]);
    expect(pageMetaSchema.parse({ tags: [2024, " go "] }).tags).toStrictEqual([
      "2024",
      "go",
    ]);
  });

  it("passes an Obsidian note's `cover` on only when the source keeps it", async () => {
    const root = await write({
      "Post.md": "---\ntitle: Post\ncover: [[art.png]]\n---\n\nText.\n",
    });
    const context = {
      cacheDir: join(root, ".blume", "cache", "obsidian"),
      mode: "build" as const,
      projectRoot: root,
    };
    const load = async (frontmatterKeys?: string[]) => {
      const { entries } = await obsidianSource(
        { frontmatterKeys, name: "obsidian", vault: "." },
        context
      ).load();
      return entries[0]?.data;
    };
    expect(await load()).toStrictEqual({ title: "Post" });
    expect(await load(["cover"])).toStrictEqual({
      cover: [["art.png"]],
      title: "Post",
    });
  });

  it("keeps the changelog list helpers under their old names", () => {
    const dates = [
      parseChangelogDate("2025-01-01"),
      parseChangelogDate("2026-01-01"),
    ];
    expect(
      dates
        .toSorted(compareChangelogDates)
        .map((date) => date?.getUTCFullYear())
    ).toEqual([2026, 2025]);
    expect(groupChangelogYears([1], () => "2026")).toEqual([
      { items: [1], year: "2026" },
    ]);
  });
});

describe("summaries", () => {
  it("pass over a blank description to the meta description or the first paragraph, in search too", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ndescription: ''\n---\n\nFirst paragraph.\n",
      "docs/blog/b.md":
        "---\ntitle: B\ntype: blog\ndescription: ' '\nseo:\n  description: From SEO.\n---\n\nBody.\n",
      "docs/guide.md":
        "---\ntitle: Guide\nseo:\n  description: From SEO.\n---\n\nBody.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(
      blogPosts(project).map((post) => [post.title, post.excerpt])
    ).toEqual([
      ["A", "First paragraph."],
      ["B", "From SEO."],
    ]);
    const documents = await buildSearchDocuments(project);
    // Any other page's search summary is its own description, as in 2.2.3.
    expect(documents.map((doc) => [doc.route, doc.description])).toEqual([
      ["/", ""],
      ["/blog/a", "First paragraph."],
      ["/blog/b", "From SEO."],
      ["/guide", ""],
    ]);
  });
});

describe("dates", () => {
  it("reads front matter, then changelog.date, then git's", () => {
    expect(
      entryDate({ meta: { date: "2026-01-01" }, published: "2020-01-01" })
    ).toBe("2026-01-01");
    expect(entryDate({ meta: { changelog: { date: "2025-01-01" } } })).toBe(
      "2025-01-01"
    );
    expect(entryDate({ meta: {}, published: "2020-01-01" })).toBe("2020-01-01");
    expect(entryDate({ meta: {} })).toBeUndefined();
  });

  it("dates an undated post by git in the sidebar and the feed", () => {
    const pages = [
      page(
        "blog/a.md",
        { title: "A", type: "blog" },
        { published: "2024-06-01T00:00:00.000Z" }
      ),
      page("blog/b.md", { date: "2020-01-01", title: "B", type: "blog" }),
    ];
    const [blog] = buildNavigation(pages, {
      datedGroups: { blog: "year" },
      folderMeta: new Map(),
    }).sidebar;
    expect(blog?.kind === "group" && outline(blog.children)).toEqual([
      { 2024: ["A"] },
      { 2020: ["B"] },
    ]);
    // SAFETY: buildRssFeeds reads only the config and the graph's pages.
    const [feed] = buildRssFeeds({
      config: blumeConfigSchema.parse({
        deployment: { site: "https://x.test" },
      }),
      graph: { pages },
    } as BlumeProject);
    // SAFETY: the two posts always yield the blog's feed.
    expect(renderRssFeed(feed as RssFeed)).toContain(
      "<pubDate>Sat, 01 Jun 2024 00:00:00 GMT</pubDate>"
    );
  });

  it("lists an undated item last in a feed, after one dated before 1970", () => {
    const pages = [
      page("changelog/a.md", { title: "Someday", type: "changelog" }),
      page("changelog/b.md", {
        date: "1969-07-20",
        title: "Moon",
        type: "changelog",
      }),
    ];
    // SAFETY: buildRssFeeds reads only the config and the graph's pages.
    const [feed] = buildRssFeeds({
      config: blumeConfigSchema.parse({
        deployment: { site: "https://x.test" },
      }),
      graph: { pages },
    } as BlumeProject);
    expect(feed?.items.map((item) => item.title)).toEqual(["Moon", "Someday"]);
  });

  it("lists each tag once in a feed item, as the index does", () => {
    const pages = [
      page("blog/a.md", {
        date: "2026-01-01",
        tags: ["Go", "go", "Rust", "Go"],
        title: "A",
        type: "blog",
      }),
    ];
    // SAFETY: buildRssFeeds reads only the config and the graph's pages.
    const [feed] = buildRssFeeds({
      config: blumeConfigSchema.parse({
        deployment: { site: "https://x.test" },
      }),
      graph: { pages },
    } as BlumeProject);
    expect(feed?.items[0]?.categories).toEqual(["Go", "Rust"]);
  });
});

describe("the sidebar's year groups", () => {
  it("leave hand-ranked posts and year folders as they are", () => {
    const meta = new Map([["blog", { pages: ["old", "new"] }]]);
    const [ranked] = buildNavigation(
      [
        page("blog/old.md", { date: "2024-01-01", title: "Old", type: "blog" }),
        page("blog/new.md", { date: "2026-01-01", title: "New", type: "blog" }),
        page("blog/mid.md", { date: "2025-01-01", title: "Mid", type: "blog" }),
      ],
      { datedGroups: { blog: "year" }, folderMeta: meta }
    ).sidebar;
    // Ranked posts keep their order and stay ungrouped (after the dated
    // ones, whose derived order runs first, as in the changelog).
    expect(ranked?.kind === "group" && outline(ranked.children)).toEqual([
      { 2025: ["Mid"] },
      "Old",
      "New",
    ]);

    const [folders] = buildNavigation(
      [
        page("blog/2024/a.md", {
          date: "2024-05-01",
          title: "A",
          type: "blog",
        }),
        page("blog/2024/b.md", {
          date: "2024-06-01",
          title: "B",
          type: "blog",
        }),
        page("blog/2025/c.md", {
          date: "2024-12-31",
          title: "C",
          type: "blog",
        }),
      ],
      { datedGroups: { blog: "year" }, folderMeta: new Map() }
    ).sidebar;
    // A folder named for the year isn't folded again; one holding another
    // year's post is.
    expect(folders?.kind === "group" && outline(folders.children)).toEqual([
      { 2024: ["B", "A"] },
      { 2025: [{ 2024: ["C"] }] },
    ]);

    // In a language whose year isn't bare digits, a `2024/` folder is still
    // that year: no `2024年` inside it, and a loose 2024 post stays loose.
    const [japanese] = buildNavigation(
      [
        page("blog/2024/a.md", {
          date: "2024-05-01",
          title: "A",
          type: "blog",
        }),
        page("blog/d.md", { date: "2024-07-01", title: "D", type: "blog" }),
        page("blog/e.md", { date: "2023-07-01", title: "E", type: "blog" }),
      ],
      { datedGroups: { blog: "year" }, folderMeta: new Map(), locale: "ja" }
    ).sidebar;
    expect(japanese?.kind === "group" && outline(japanese.children)).toEqual([
      "D",
      { "2023年": ["E"] },
      { 2024: ["A"] },
    ]);

    // A month folder in a year folder (`2025/03/`) is in that year too, and
    // only a post of another year gets a group of its own there.
    const [nested] = buildNavigation(
      [
        page("blog/2025/03/a.md", {
          date: "2025-03-01",
          title: "A",
          type: "blog",
        }),
        page("blog/2025/03/b.md", {
          date: "2025-03-02",
          title: "B",
          type: "blog",
        }),
        page("blog/2025/c.md", {
          date: "2025-05-01",
          title: "C",
          type: "blog",
        }),
        page("blog/2025/d.md", {
          date: "2024-12-31",
          title: "D",
          type: "blog",
        }),
      ],
      { datedGroups: { blog: "year" }, folderMeta: new Map() }
    ).sidebar;
    expect(nested?.kind === "group" && outline(nested.children)).toEqual([
      { 2025: ["C", { 2024: ["D"] }, { "03": ["B", "A"] }] },
    ]);

    // A month folder matches its month in a language that writes months in
    // lowercase (`mars 2025`), whatever case its label is in.
    const [french] = buildNavigation(
      [
        page("blog/mars 2025/a.md", {
          date: "2025-03-01",
          title: "A",
          type: "blog",
        }),
        page("blog/b.md", { date: "2025-03-05", title: "B", type: "blog" }),
      ],
      { datedGroups: { blog: "month" }, folderMeta: new Map(), locale: "fr" }
    ).sidebar;
    expect(french?.kind === "group" && outline(french.children)).toEqual([
      "B",
      { "Mars 2025": ["A"] },
    ]);

    // By month, a month folder in its year's (`2025/03/`) or named for both
    // (`2025-05/`) is that month already.
    const [months] = buildNavigation(
      [
        page("blog/2025/03/a.md", {
          date: "2025-03-01",
          title: "A",
          type: "blog",
        }),
        page("blog/2025-05/b.md", {
          date: "2025-05-02",
          title: "B",
          type: "blog",
        }),
        page("blog/2025/c.md", {
          date: "2025-06-03",
          title: "C",
          type: "blog",
        }),
      ],
      { datedGroups: { blog: "month" }, folderMeta: new Map() }
    ).sidebar;
    expect(months?.kind === "group" && outline(months.children)).toEqual([
      { 2025: [{ "June 2025": ["C"] }, { "03": ["A"] }] },
      { "2025 05": ["B"] },
    ]);

    // A bare number names a month only in its year's folder: elsewhere it may
    // be a series' `3/`, which leaves a March post its group.
    const [series] = buildNavigation(
      [
        page("blog/3/part.md", { title: "Part three", type: "blog" }),
        page("blog/a.md", { date: "2025-03-10", title: "March", type: "blog" }),
      ],
      { datedGroups: { blog: "month" }, folderMeta: new Map() }
    ).sidebar;
    expect(series?.kind === "group" && outline(series.children)).toEqual([
      { "March 2025": ["March"] },
      { 3: ["Part three"] },
    ]);
  });

  it("read a date in the site's time zone, as the index does", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { dateFormat: { dateStyle: "long", timeZone: "Pacific/Auckland" } };\n',
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ndate: 2026-12-31T23:30:00Z\n---\n\nBody.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const blog = project.graph.navigation.sidebar.find(
      (node) => node.label === "Blog"
    );
    expect(blog?.kind === "group" && outline(blog.children)).toEqual([
      { 2027: ["A"] },
    ]);
  });

  it("label in English where the locale code isn't one Intl reads", () => {
    const [blog] = buildNavigation(
      [page("blog/a.md", { date: "2026-05-01", title: "A", type: "blog" })],
      { datedGroups: { blog: "month" }, folderMeta: new Map(), locale: "pt_BR" }
    ).sidebar;
    expect(blog?.kind === "group" && outline(blog.children)).toEqual([
      { "May 2026": ["A"] },
    ]);
  });

  it("open up in a directory, which lists the posts", () => {
    const group: NavGroup = {
      children: [
        {
          children: [
            { kind: "page", label: "A", pageId: "a", route: "/blog/a" },
          ],
          display: "group",
          kind: "group",
          label: "2026",
          period: "year",
        },
        { kind: "page", label: "B", pageId: "b", route: "/blog/b" },
      ],
      display: "flat",
      kind: "group",
      label: "Blog",
      route: "/blog",
    };
    expect(directoryEntries(group).map((entry) => entry.label)).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("a /blog tab", () => {
  it("opens the index in every language, as a /changelog tab does", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }, navigation: { tabs: [{ label: "Docs", path: "/" }, { label: "Blog", path: "/blog" }, { label: "News", path: "/changelog" }] } };\n',
      "docs/en/blog/a.md":
        "---\ntitle: A\ntype: blog\ndate: 2026-01-01\n---\n\nText.\n",
      "docs/en/changelog/v1.md":
        "---\ntitle: V1\ntype: changelog\ndate: 2026-01-01\n---\n\nText.\n",
      "docs/en/index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "docs/fr/blog/a.md":
        "---\ntitle: A\ntype: blog\ndate: 2026-01-01\n---\n\nTexte.\n",
      "docs/fr/changelog/v1.md":
        "---\ntitle: V1\ntype: changelog\ndate: 2026-01-01\n---\n\nTexte.\n",
      "docs/fr/index.md": "---\ntitle: Accueil\n---\n\nAccueil.\n",
    });
    // The Blog and News tabs' targets: each index serves every language.
    const targets = (code: string) =>
      (project.graph.navigationByLocale[code]?.tabs ?? [])
        .slice(1)
        .map((tab) => tab.href ?? tab.path);
    expect(targets("en")).toEqual(["/blog", "/changelog"]);
    expect(targets("fr")).toEqual(["/blog", "/changelog"]);
  });
});

describe("front matter images", () => {
  it("are checked by blume validate, as the body's are", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ncover: ./covr.png\nauthors:\n  - name: Ada\n    avatar: /ada.png\n  - name: Grace\n    avatar: https://x.test/g.png\n  - name: Lin\n    avatar: lin\n---\n\nText.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const diagnostics = await validateLinks(project.graph, {
      checkExternal: false,
      publicDir: null,
      redirects: [],
    });
    expect(
      diagnostics
        .filter((diagnostic) => diagnostic.code === "BLUME_BROKEN_ASSET")
        .map((diagnostic) => [diagnostic.line, diagnostic.message])
    ).toEqual([
      [1, "Image ./covr.png was not found next to a.md."],
      [1, "Asset /ada.png was not found in the public directory."],
    ]);
    // A free-form value (`avatar: lin`) is no file to look for, nor a link.
    expect(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    ).toEqual([]);
  });
});

describe("the site skill", () => {
  it("lists each post when the site's own page holds /blog", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" } };\n',
      "docs/blog/a.md":
        "---\ntitle: A post\ntype: blog\ndate: 2026-01-01\n---\n\nBody.\n",
      "docs/blog/index.md": "---\ntitle: Our blog\n---\n\n<Blog />\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const skill = new TextDecoder().decode(buildSiteSkill(project)?.content);
    // Summarized by its first paragraph, as llms.txt does.
    expect(skill).toContain("[A post](https://x.test/blog/a.md): Body.");
    expect(skill).not.toContain("blog posts, newest first");
    // A post's year is no section of the map.
    expect(skill).not.toContain("# 2026");
  });
});

describe("a post a locale hasn't translated", () => {
  it("lists its fallback copy as that locale's post", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };\n',
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ndate: 2026-01-01\n---\n\nBody.\n",
      "docs/index.fr.md": "---\ntitle: Accueil\n---\n\nAccueil.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(
      blogPosts(project).map((post) => [post.route, post.locale, post.fallback])
    ).toEqual([
      ["/blog/a", "en", false],
      ["/fr/blog/a", "fr", true],
    ]);
  });
});

describe("an author's link", () => {
  it("is a site path under the bases, in the post's language", async () => {
    const author =
      "authors:\n  - name: Hedy\n    url: /team/hedy\n  - name: Ada\n    url: /ada.vcf\n";
    const project = await scanFixture({
      "blume.config.ts":
        'export default { basePath: "/docs", i18n: { defaultLocale: "en", parser: "dot", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };\n',
      "docs/blog/a.fr.md": `---\ntitle: A\ntype: blog\n${author}---\n\nCorps.\n`,
      "docs/blog/a.md": `---\ntitle: A\ntype: blog\n${author}---\n\nBody.\n`,
      "docs/blog/b.md": `---\ntitle: B\ntype: blog\n${author}---\n\nBody.\n`,
      "docs/index.fr.md": "---\ntitle: Accueil\n---\n\nAccueil.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "docs/team/hedy.fr.md": "---\ntitle: Hedy\n---\n\nHedy.\n",
      "docs/team/hedy.md": "---\ntitle: Hedy\n---\n\nHedy.\n",
    });
    expect(
      blogPosts(project).map((post) => [
        post.route,
        ...post.authors.map((entry) => entry.url),
      ])
    ).toEqual([
      ["/docs/fr/blog/a", "/docs/fr/team/hedy", "/ada.vcf"],
      ["/docs/blog/a", "/docs/team/hedy", "/ada.vcf"],
      ["/docs/blog/b", "/docs/team/hedy", "/ada.vcf"],
      // b's French copy, falling back to the default locale's post. A file
      // under `public/` stays at the site root, as a body link to it does.
      ["/docs/fr/blog/b", "/docs/fr/team/hedy", "/ada.vcf"],
    ]);
  });

  it("names a dotted page, percent-encoded, as a body link does", async () => {
    const project = await scanFixture({
      "blume.config.ts": 'export default { basePath: "/docs" };\n',
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\nauthors:\n  - name: José\n    url: /team/jos%C3%A9.smith\n---\n\nBody.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "docs/team/josé.smith.md": "---\ntitle: José\n---\n\nJosé.\n",
    });
    expect(blogPosts(project)[0]?.authors[0]?.url).toBe(
      "/docs/team/jos%C3%A9.smith"
    );
  });
});

describe("the OG endpoint's tag cards", () => {
  it("come with the generated tag pages, whoever owns /blog", () => {
    const endpoint = ogEndpointTemplate([], {}, false, {
      covers: {},
      index: false,
      tags: true,
    });
    expect(endpoint).toContain("for (const tag of data.blog?.tags ?? [])");
    expect(endpoint).toContain('.replace("{tag}", () => tag.label)');
    expect(endpoint).not.toContain('add("blog"');
  });

  it("key a local cover by its bytes, wherever the checkout is", async () => {
    const [one, two] = await Promise.all([
      write({ "c.png": "same" }),
      write({ "c.png": "same" }),
    ]);
    expect(await coverKey(one)).toBe(await coverKey(two));
  });
});

describe("a feed carrying whole pages", () => {
  it("reads each page for people: no agent-only text, module lines, or bare anchors", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, seo: { rss: { content: true } } };\n',
      "docs/blog/a.mdx": [
        "---",
        "title: A",
        "type: blog",
        "---",
        "",
        'import { Thing } from "./thing.ts";',
        "",
        '<Visibility for="agents">AGENT ONLY</Visibility>',
        "",
        '<Visibility for="web">For people.</Visibility>',
        "",
        "See [below](#more).",
        "",
        "```ts",
        'import { kept } from "code";',
        "```",
        "",
        "## More",
        "",
      ].join("\n"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const markdown = await buildFeedMarkdown(project);
    expect(Object.keys(markdown)).toEqual(["/blog/a"]);
    const [feed] = buildRssFeeds(project, markdown);
    // SAFETY: the post always yields the blog's feed.
    const xml = renderRssFeed(feed as RssFeed);
    expect(xml).not.toContain("AGENT ONLY");
    expect(xml).toContain("For people.");
    expect(xml).not.toContain("import { Thing }");
    expect(xml).toContain("import { kept }");
    expect(xml).toContain("href=&quot;https://x.test/blog/a#more&quot;");
  });

  it("reads Blume's own Markdown as a reader would see it, code aside", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, seo: { rss: { content: true } } };\n',
      "docs/blog/a.mdx": [
        "---",
        "title: A",
        "type: blog",
        "---",
        "",
        "## Setup [#setup]",
        "",
        "### Aside [!toc]",
        "",
        "## Only in the outline [toc]",
        "",
        ":::note[Heads up]",
        "Mind the gap.{/* inside the callout */}",
        ":::",
        "",
        "{/* a note to editors */}",
        "",
        "{/* one */} { /* two */ }",
        "",
        "{/* a note",
        "",
        "across paragraphs */}",
        "",
        "## Marked [#marked] {/* aside */}",
        "",
        "Rule below",
        "{/* a rule, not an underline */}",
        "---",
        "",
        "Soft  {/* no hard break */}",
        "break, *left*{/* apart */}*right*.",
        "",
        "Escaped \\{/* shown */} stays, foo{/* c */}_bar_ too, `x`{/* c */}`y` and [a]{/* c */}(/z) apart.",
        "",
        "{/* a */} Kept between notes. {/* b */}",
        "",
        "Write `{/* hidden */}` to hide a line, *quietly {/* hush */} so*.",
        "",
        "Before the note.",
        "  {/* an indented note */}",
        "After the note.",
        "",
        ":::tip[Indented]",
        "  Inside the tip.",
        "  :::",
        "",
        "As noted[^1].",
        "",
        "[^1]: Ibid.",
        "",
        "```md",
        ":::note[Kept]",
        "## Kept [#kept]",
        "```",
        "",
        "    ## Indented [#kept]",
        "    :::note[Indented]",
        "",
        "- ```md",
        "  :::note[Listed]",
        "  ```",
        "",
      ].join("\n"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const [feed] = buildRssFeeds(project, await buildFeedMarkdown(project));
    // SAFETY: the post always yields the blog's feed.
    const html = (feed as RssFeed).items[0]?.content ?? "";
    expect(html).toContain("<h2>Setup</h2>");
    expect(html).toContain("<h3>Aside</h3>");
    expect(html).not.toContain("Only in the outline");
    expect(html).toContain("<strong>Heads up</strong>");
    expect(html).toContain("Mind the gap.");
    expect(html).not.toContain("a note to editors");
    expect(html).not.toContain("inside the callout");
    expect(html).not.toContain("two");
    expect(html).not.toContain("across paragraphs");
    expect(html).toContain("<h2>Marked</h2>");
    expect(html).toContain("<p>Rule below</p>\n<!---->\n<hr>");
    expect(html).toContain(
      "<p>Soft\nbreak, <em>left</em><!----><em>right</em>.</p>"
    );
    // An escaped brace is text the page shows.
    expect(html).toContain(
      "<p>Escaped {/* shown */} stays, foo<!----><em>bar</em> too, <code>x</code><!----><code>y</code> and [a]<!---->(/z) apart.</p>"
    );
    expect(html).toContain("<p>Kept between notes.</p>");
    expect(html).toContain(
      "<code>{/* hidden */}</code> to hide a line, <em>quietly <!----> so</em>."
    );
    // Indented as a paragraph's lines may be, a note and a fence still go.
    // A comment alone on its line is a block of its own, as MDX reads it.
    expect(html).toContain("<p>Before the note.</p>\n<p>After the note.</p>");
    expect(html).not.toContain("an indented note");
    expect(html).toContain("<strong>Indented</strong>");
    expect(html).toContain("<p>  Inside the tip.</p>");
    // A relative href resolves against nothing in a reader: text, unlinked.
    expect(html).toContain("As noted^1.");
    expect(html).not.toContain('href="Ibid."');
    // Code is shown as written: fenced, indented, or in a list.
    expect(html).toContain(":::note[Kept]\n## Kept [#kept]");
    expect(html).toContain("## Indented [#kept]\n:::note[Indented]");
    expect(html).toContain(":::note[Listed]");
    expect(html).not.toMatch(/<p>:::/u);
  });

  it("drops a module statement over several lines, and reads past a page MDX rejects", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, seo: { rss: { content: true } } };\n',
      "docs/blog/a.mdx": [
        "---",
        "title: A",
        "type: blog",
        "---",
        "",
        "import {",
        "  Alpha,",
        "  Beta,",
        '} from "./parts.ts";',
        "export const meta = {",
        "  x: 1,",
        "};",
        "",
        "Body text.",
        "",
      ].join("\n"),
      "docs/blog/b.mdx":
        "---\ntitle: B\ntype: blog\n---\n\n<!-- MDX rejects an HTML comment -->\n\nStill here.\n",
      "docs/blog/c.md":
        "---\ntitle: C\ntype: blog\nhidden: true\n---\n\nHidden.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const markdown = await buildFeedMarkdown(project);
    // A hidden page is no feed item, so its page isn't read.
    expect(Object.keys(markdown).toSorted()).toEqual(["/blog/a", "/blog/b"]);
    expect(markdown["/blog/a"]).not.toContain("Alpha");
    expect(markdown["/blog/a"]).not.toContain("x: 1");
    expect(markdown["/blog/a"]).toContain("Body text.");
    expect(markdown["/blog/b"]).toContain("Still here.");
  });

  it("removes a module statement where it is, not a copy shown in code before it", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, seo: { rss: { content: true } } };\n',
      "docs/blog/a.mdx": [
        "---",
        "title: A",
        "type: blog",
        "---",
        "",
        "```ts",
        'import A from "./a.ts";',
        "```",
        "",
        'import A from "./a.ts";',
        "",
        "Text.",
        "",
      ].join("\n"),
      // A downleveled component before the statement moves it in the
      // Markdown, which then finds it by its text.
      "docs/blog/b.mdx": [
        "---",
        "title: B",
        "type: blog",
        "---",
        "",
        '<Callout type="info">A long note before the module statement.</Callout>',
        "",
        'import B from "./b.ts";',
        "",
        "Text.",
        "",
      ].join("\n"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const markdown = await buildFeedMarkdown(project);
    expect(markdown["/blog/a"]).toContain(
      '```ts\nimport A from "./a.ts";\n```'
    );
    expect(markdown["/blog/a"]?.split('import A from "./a.ts";')).toHaveLength(
      2
    );
    expect(markdown["/blog/b"]).not.toContain("import B");
    expect(markdown["/blog/b"]).toContain("A long note");
  });

  it("drops what XML can't carry, and makes single-quoted links absolute", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, seo: { rss: { content: true } } };\n',
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\n---\n\nA bell \u0007 and a tab\tstay apart.\n\n<a href='/guide'>Guide</a> and <a href='#top'>top</a>.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const [feed] = buildRssFeeds(project, await buildFeedMarkdown(project));
    // SAFETY: the post always yields the blog's feed.
    const xml = renderRssFeed(feed as RssFeed);
    expect(xml).not.toContain("\u0007");
    expect(xml).toContain("A bell  and a tab\tstay apart.");
    expect(xml).toContain("href=&#39;https://x.test/guide&#39;");
    expect(xml).toContain("href=&#39;https://x.test/blog/a#top&#39;");
  });

  it("cuts an MDX page's comments so the rest parses as the page did", () => {
    const cases: [string, string][] = [
      // Alone on its line, a block: the paragraph or list before it ends.
      ["Before.\n  {/* note */}\nAfter.", "Before.\n\nAfter."],
      ["- a\n{/* c */}\n- b", "- a\n<!---->\n- b"],
      ["Start.\n\n{/* c */}\n\nEnd.", "Start.\n\n\n\nEnd."],
      // Ending a line: the spaces before it go, those after (a break) stay.
      ["text  {/* c */}\nnext", "text\nnext"],
      ["text{/* c */}  \nnext", "text  \nnext"],
      // Mid-line, an empty HTML comment keeps apart what it parted.
      ["*a*{/* c */}*b*", "*a*<!---->*b*"],
      ["x {/* a */} {/* b */}y", "x <!----> <!---->y"],
      ["a {/* x */ /* y */} b {// z\n} c", "a <!----> b <!----> c"],
      // Code and an escaped brace keep theirs.
      [
        "`{/* code */}` and \\{/* text */}",
        "`{/* code */}` and \\{/* text */}",
      ],
      ["```\n{/* fenced */}\n```", "```\n{/* fenced */}\n```"],
      // Opening a line: text MDX read as a paragraph stays one.
      ["{/* c */} Text", "Text"],
      ["  {/* c */}\tText", "  Text"],
      ["{/* c */}# Not a heading", "&zwnj;# Not a heading"],
      // Ending one: no rule, heading or closing sequence the page lacked.
      ["---  {/* c */}", "---&zwnj;"],
      ["#{/* c */}", "#&zwnj;"],
      ["# a # {/* c */}", "# a #&zwnj;"],
      ["_{/* c */}\nx_", "_<!---->\nx_"],
      // A list item's only content, and a table's row.
      ["para\n- {/* c */}", "para\n- <!---->"],
      ["-  {/* c */}\n  - b", "-  <!---->\n  - b"],
      // A table it ends, as on the page.
      ["| a |\n|---|\n{/* c */}\n| b |", "| a |\n|---|\n<!---->\n| b |"],
      // A definition or a task's box it ended stays text and an item.
      ["[a]: /x {/* c */}", "[a]: /x &zwnj;"],
      ["- [ ] {/* c */}", "- [ ] &zwnj;"],
      ["> {/* c */}", ">"],
    ];
    for (const [body, cut] of cases) {
      expect(withoutJsxComments(body)).toBe(cut);
    }
  });

  it("keeps the comment a Markdown page shows as text", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, seo: { rss: { content: true } } };\n',
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\n---\n\nWrite {/* shown */} as is.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const [feed] = buildRssFeeds(project, await buildFeedMarkdown(project));
    // SAFETY: the post always yields the blog's feed.
    expect((feed as RssFeed).items[0]?.content).toBe(
      "<p>Write {/* shown */} as is.</p>"
    );
  });

  it("reads only the pages within the feed's limit", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, seo: { rss: { content: true, limit: 1 } } };\n',
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ndate: 2026-01-01\n---\n\nOld.\n",
      "docs/blog/b.md":
        "---\ntitle: B\ntype: blog\ndate: 2026-02-01\n---\n\nNew.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(Object.keys(await buildFeedMarkdown(project))).toEqual(["/blog/b"]);
  });

  it("reads no page when the feed carries summaries", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md": "---\ntitle: A\ntype: blog\n---\n\nBody.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(await buildFeedMarkdown(project)).toStrictEqual({});
  });
});
