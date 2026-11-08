import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildAskData } from "../src/ai/ask-data.ts";
import {
  blogComponentSerializers,
  buildBlogIndexMarkdown,
} from "../src/ai/blog-markdown.ts";
import { downlevelComponents } from "../src/ai/component-markdown.ts";
import {
  agentMarkdown,
  buildRawMarkdown,
  markdownRoutePaths,
  buildFeedMarkdown,
} from "../src/ai/markdown.ts";
import { buildSiteSkill } from "../src/ai/site-skill.ts";
import { blogPageFiles } from "../src/astro/blog-pages.ts";
import { buildRuntimeData } from "../src/astro/generate.ts";
import {
  generatedBlogTagRoutes,
  hasGeneratedBlog,
  navTargetRoutes,
} from "../src/astro/pages.ts";
import { blogPageTemplate } from "../src/astro/templates.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { buildRssFeeds, renderRssFeed } from "../src/deploy/rss.ts";
import type { RssFeed } from "../src/deploy/rss.ts";
import { buildSitemapFiles } from "../src/deploy/sitemap.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import type { JsonLdNode } from "../src/seo/jsonld.ts";

/**
 * Every surface beyond the post's own page that lists the blog: its
 * generated pages, the `/blog.md` mirror and `<Blog />`, the feed, the
 * sitemap, the site skill, and the page data the index renders from.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scanFixture = async (
  files: Record<string, string>
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-blog-surfaces-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return await scanProject(root);
};

const SITE = {
  "docs/blog/a.md": [
    "---",
    "title: '[Beta] Webhooks'",
    "type: blog",
    "date: 2026-05-01",
    "authors: [Ada, Grace]",
    "tags: [Go, Rust]",
    "---",
    "",
    "Webhooks are here, see [the guide](/guide).",
    "",
    "![Diagram](/images/d.png)",
    "",
  ].join("\n"),
  "docs/blog/b.md":
    "---\ntitle: Older\ntype: blog\ndate: 2025-01-02\ndescription: Described.\ntags: [Go]\n---\n\nBody.\n",
  "docs/blog/c.md": "---\ntitle: Undated\ntype: blog\n---\n\nUndated body.\n",
  "docs/blog/d.md":
    "---\ntitle: Hidden\ntype: blog\ndate: 2026-06-01\nhidden: true\ntags: [Secret]\n---\n\nHidden.\n",
  "docs/guide.md": "---\ntitle: Guide\n---\n\nThe guide.\n",
  "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
};

const CONFIG =
  'export default { title: "Acme", deployment: { site: "https://x.test" }, blog: { title: "Notes", sidebar: { width: "20rem" } }, changelog: { sidebar: { width: "18rem" } }, seo: { rss: { content: true } } };\n';

describe("the generated blog pages", () => {
  it("are the index and the tag page, while posts exist and no page owns them", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    expect(hasGeneratedBlog(project, [])).toBe(true);
    expect(generatedBlogTagRoutes(project, [])).toEqual([
      "/blog/tags/go",
      "/blog/tags/rust",
    ]);
    const routes = navTargetRoutes(project, []);
    expect(routes.has("/blog")).toBe(true);
    expect(routes.has("/blog/tags/rust")).toBe(true);

    const options = { exportEpub: false, exportPdf: false, needsReact: false };
    expect(
      blogPageFiles(project, [], "/src", options).map((file) => file.path)
    ).toEqual(["/src/pages/blog.astro", "/src/pages/blog/tags/[tag].astro"]);

    // A user page owning the index or a tag's route keeps it.
    const owned = blogPageFiles(
      project,
      [{ pattern: "/blog" }, { pattern: "/blog/tags/go" }],
      "/src",
      options
    );
    expect(owned.map((file) => file.path)).toEqual([
      "/src/pages/blog/tags/[tag].astro",
    ]);
    expect(owned[0]?.content).toContain(
      'const taken = new Set<string>(["go"]);'
    );
    expect(
      blogPageFiles(
        project,
        [
          { pattern: "/blog" },
          { pattern: "/blog/tags/go" },
          { pattern: "/blog/tags/rust" },
        ],
        "/src",
        options
      )
    ).toEqual([]);
  });

  it("leave a route a configured redirect answers to the redirect", async () => {
    const post =
      "---\ntitle: A\ntype: blog\ndate: 2026-01-01\ntags: [Go]\n---\n\nText.\n";
    const moved = await scanFixture({
      "blume.config.ts":
        'export default { redirects: [{ from: "/blog/:slug*", to: "/posts/:slug*" }] };\n',
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "docs/posts/a.md": post,
    });
    // As before the blog: no generated page collides with the redirect.
    expect(
      moved.diagnostics.filter(
        (diagnostic) => diagnostic.code === "BLUME_REDIRECT_MATCHES_PAGE"
      )
    ).toEqual([]);
    expect(hasGeneratedBlog(moved, [])).toBe(false);
    expect(generatedBlogTagRoutes(moved, [])).toEqual([]);
    const index = await scanFixture({
      "blume.config.ts":
        'export default { redirects: [{ from: "/blog", to: "/posts" }] };\n',
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "docs/posts/a.md": post,
    });
    expect(hasGeneratedBlog(index, [])).toBe(false);
    expect(generatedBlogTagRoutes(index, [])).toEqual(["/blog/tags/go"]);
    // A tag whose page a redirect owns isn't offered as a link.
    expect(JSON.parse(buildRuntimeData(moved)).blog.tags).toEqual([]);
    expect(JSON.parse(buildRuntimeData(index)).blog.tags).toHaveLength(1);
  });

  it("leave a route a user page's dynamic pattern answers to that page", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    expect(
      generatedBlogTagRoutes(project, [{ pattern: "/blog/tags/[tag]" }])
    ).toEqual([]);
    expect(hasGeneratedBlog(project, [{ pattern: "/blog/tags/[tag]" }])).toBe(
      true
    );
    // A rest parameter takes the rest, nothing included.
    const rest = [{ pattern: "/blog/[...slug]" }];
    expect(hasGeneratedBlog(project, rest)).toBe(false);
    expect(generatedBlogTagRoutes(project, rest)).toEqual([]);
    // One parameter takes one segment.
    const one = [{ pattern: "/blog/[slug]" }];
    expect(hasGeneratedBlog(project, one)).toBe(true);
    expect(generatedBlogTagRoutes(project, one)).toHaveLength(2);
    // A parameter where Blume's pattern is static (`tags`) ranks below it.
    const archive = [{ pattern: "/blog/[category]/[slug]" }];
    expect(generatedBlogTagRoutes(project, archive)).toHaveLength(2);
    // A site-wide dynamic page rarely serves the blog: it keeps its pages.
    for (const pattern of ["/[product]", "/[...slug]"]) {
      expect(hasGeneratedBlog(project, [{ pattern }])).toBe(true);
      expect(generatedBlogTagRoutes(project, [{ pattern }])).toHaveLength(2);
    }
    expect(
      generatedBlogTagRoutes(project, [{ pattern: "/blog/tags/tag-[id]" }])
    ).toHaveLength(2);
    expect(
      generatedBlogTagRoutes(project, [{ pattern: "/blog/tags/g[x]" }])
    ).toEqual(["/blog/tags/rust"]);
    // Tabs and links may point at the routes Blume generates.
    expect([...navTargetRoutes(project, [])]).toEqual(
      expect.arrayContaining(["/blog", "/blog/tags/go", "/blog/tags/rust"])
    );
    expect([...navTargetRoutes(project, rest)]).not.toContain("/blog");
  });

  it("are none without visible posts", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(hasGeneratedBlog(project, [])).toBe(false);
    expect(generatedBlogTagRoutes(project, [])).toEqual([]);
    expect(
      blogPageFiles(project, [], "/src", {
        exportEpub: false,
        exportPdf: false,
        needsReact: false,
      })
    ).toEqual([]);
  });

  it("render the list under the blog strings", () => {
    const index = blogPageTemplate({
      exportEpub: true,
      exportPdf: false,
      needsReact: true,
    });
    expect(index).toContain(
      'import { BLOG_INDEX_ROUTE } from "blume/core/blog.ts";'
    );
    expect(index).toContain('from "../generated/components.ts"');
    expect(index).toContain("const route = BLOG_INDEX_ROUTE;");
    expect(index).toContain("<Blog />");
    expect(index).toContain("exportEpub={true}");
    expect(index).toContain("clientData={{");
    expect(index).not.toContain("getStaticPaths");

    const tags = blogPageTemplate({
      exportEpub: false,
      exportPdf: false,
      needsReact: false,
      tags: { taken: [] },
    });
    expect(tags).toContain(
      'import { blogTagRoute } from "blume/core/blog.ts";'
    );
    expect(tags).toContain('from "../../../generated/components.ts"');
    expect(tags).toContain("export function getStaticPaths()");
    expect(tags).toContain("const taken = new Set<string>([]);");
    expect(tags).toContain("<Blog tag={tag} />");
    expect(tags).not.toContain("clientData");
  });
});

describe("the blog's Markdown", () => {
  it("mirrors the index at /blog.md and for MCP get_page", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    expect(buildBlogIndexMarkdown(project)).toBe(
      [
        "# Notes",
        "",
        "News, updates, and stories from the team.",
        "",
        "## 2026",
        "",
        "- [\\[Beta\\] Webhooks](https://x.test/blog/a) — 2026-05-01 · Ada, Grace · Go, Rust",
        "  Webhooks are here, see the guide.",
        "",
        "## 2025",
        "",
        "- [Older](https://x.test/blog/b) — 2025-01-02 · Go",
        "  Described.",
        "",
        "## Undated",
        "",
        "- [Undated](https://x.test/blog/c)",
        "  Undated body.",
        "",
      ].join("\n")
    );
    const raw = await buildRawMarkdown(project);
    expect(raw["/blog"]?.mdx).toBe(buildBlogIndexMarkdown(project));
    expect(markdownRoutePaths(project)).toContain("/blog");
  });

  it("points a post's front matter images at their served URLs in its mirror", async () => {
    const project = await scanFixture({
      "docs/blog/a.md": [
        "---",
        "title: A",
        "type: blog",
        'cover: "./c.png"',
        "authors:",
        "  - name: Ada",
        "    avatar: ./ada.png # headshot",
        "  - name: Lin",
        "    avatar: ./gone.png",
        "seo:",
        "  image: ./og.png",
        "---",
        "",
        "Text.",
        "",
      ].join("\n"),
      "docs/blog/ada.png": "png",
      "docs/blog/c.png": "png",
      "docs/blog/og.png": "png",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const raw = await buildRawMarkdown(project);
    const entry = raw["/blog/a"];
    const md = entry ? agentMarkdown(entry) : "";
    expect(md).toContain('cover: "/blume-assets/content/docs/blog/c.png"');
    expect(md).toContain(
      "avatar: /blume-assets/content/docs/blog/ada.png # headshot"
    );
    // A path that names no file, and a key the blog doesn't own, stay.
    expect(md).toContain("avatar: ./gone.png");
    expect(md).toContain("image: ./og.png");
  });

  it("writes an excerpt and details that read as written, not as Markdown", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ntags: [C++, '<b>']\n---\n\n\\# Not a *heading*\n",
      "docs/blog/b.md": "---\ntitle: B\ntype: blog\n---\n\n1\\. Not a list\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const markdown = buildBlogIndexMarkdown(project);
    expect(markdown).toContain(
      "- [A](/blog/a) — C++, \\<b\\>\n  \\# Not a heading"
    );
    expect(markdown).toContain("- [B](/blog/b)\n  1\\. Not a list");
  });

  it("heads a localized site's mirror in the default locale's words", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { i18n: { defaultLocale: "sv", locales: [{ code: "sv", label: "Svenska" }] } };\n',
      "docs/blog/a.md": "---\ntitle: A\ntype: blog\n---\n\nText.\n",
      "docs/index.md": "---\ntitle: Hem\n---\n\nHem.\n",
    });
    expect(buildBlogIndexMarkdown(project)).toStartWith(
      "# Blogg\n\nNyheter, uppdateringar och berättelser från teamet.\n\n## Undated\n\n- [A](/blog/a)\n  Text."
    );
  });

  it("keeps a multi-line description on its entry's line in /blog.md", async () => {
    const project = await scanFixture({
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ndate: 2026-01-01\ndescription: |\n  line one\n  # not heading\n  - item\n---\n\nText.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(buildBlogIndexMarkdown(project)).toContain(
      "- [A](/blog/a) — 2026-01-01\n  line one # not heading - item\n"
    );
  });

  it("downlevels <Blog /> to the same list, one tag's with `tag`", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    const serializers = blogComponentSerializers(project);
    const all = downlevelComponents("<Blog />\n", serializers);
    expect(all).toContain("## 2026");
    expect(all).toContain("[Undated]");
    const rust = downlevelComponents('<Blog tag="rust" />\n', serializers);
    expect(rust).toContain("[\\[Beta\\] Webhooks]");
    expect(rust).not.toContain("[Older]");
    // A tag's label names the same tag as its slug.
    expect(downlevelComponents('<Blog tag="Rust" />\n', serializers)).toBe(
      rust
    );
    // A non-string tag lists everything.
    expect(downlevelComponents("<Blog tag={1} />\n", serializers)).toContain(
      "[Older]"
    );
  });

  it("leaves <Blog /> as written on a site with no posts to list", async () => {
    // There the tag is likelier the site's own component than the list.
    const project = await scanFixture({
      "docs/index.mdx": "---\ntitle: Home\n---\n\n<Blog />\n",
    });
    expect(
      downlevelComponents("<Blog />\n", blogComponentSerializers(project))
    ).toBe("<Blog />\n");
  });

  it("links a page's <Blog /> by route in the assistant's snapshot", async () => {
    // The mirror links posts where a reader fetches them; the assistant's
    // excerpts link pages by route, which the chat panel mounts.
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { base: "/sub", site: "https://docs.example.com" } };\n',
      "docs/blog/notes (old).md":
        "---\ntitle: Old notes\ntype: blog\ndate: 2025-01-15\n---\n\nOld.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "docs/news.mdx": "---\ntitle: News\n---\n\n<Blog />\n",
    });
    // Written as llms.txt writes a page's URL, so the parenthesis can't
    // split the link there either.
    const raw = await buildRawMarkdown(project);
    expect(raw["/news"]?.md).toContain(
      "- [Old notes](https://docs.example.com/sub/blog/notes%20%28old%29) — 2025-01-15"
    );
    const { documents } = await buildAskData(project);
    expect(documents.find((doc) => doc.route === "/news")?.content).toContain(
      "- [Old notes](/blog/notes%20%28old%29) — 2025-01-15"
    );
  });

  it("dates /blog.md in the configured time zone, as the page does", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { dateFormat: { dateStyle: "long", timeZone: "Pacific/Auckland" } };\n',
      "docs/blog/a.md":
        "---\ntitle: New year\ntype: blog\ndate: 2026-12-31T23:30:00Z\n---\n\nText.\n",
      "docs/blog/b.md":
        "---\ntitle: Old\ntype: blog\ndate: 0999-06-01\n---\n\nText.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(buildBlogIndexMarkdown(project)).toContain(
      "## 2027\n\n- [New year](/blog/a) — 2027-01-01"
    );
    // A year before 1000 heads its posts as the page does, its days in ISO's
    // four digits.
    expect(buildBlogIndexMarkdown(project)).toContain(
      "## 999\n\n- [Old](/blog/b) — 0999-06-01"
    );
  });

  it("links the index from the site skill, in place of each post", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    const skill = new TextDecoder().decode(buildSiteSkill(project)?.content);
    expect(skill).toContain(
      "- [Blog](https://x.test/blog.md): blog posts, newest first."
    );
    expect(skill).not.toContain("blog/b");
  });
});

describe("the blog's feed", () => {
  it("carries authors, tags, and the whole post, under the blog's title", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    const [feed] = buildRssFeeds(project, await buildFeedMarkdown(project));
    expect(feed?.title).toBe("Acme — Notes");
    expect(feed?.items.map((item) => item.title)).toEqual([
      "[Beta] Webhooks",
      "Older",
      "Undated",
    ]);
    // SAFETY: the fixture's posts always yield the blog's feed.
    const xml = renderRssFeed(feed as RssFeed);
    expect(xml).toContain(
      ' xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
    );
    expect(xml).toContain(
      "<dc:creator>Ada</dc:creator>\n    <dc:creator>Grace</dc:creator>"
    );
    expect(xml).toContain(
      "<category>Go</category>\n    <category>Rust</category>"
    );
    // The post's first paragraph stands in for a missing description.
    expect(xml).toContain(
      "<description>Webhooks are here, see the guide.</description>"
    );
    // The whole post, with root-relative links and images made absolute.
    expect(xml).toContain(
      "<content:encoded>&lt;p&gt;Webhooks are here, see &lt;a href=&quot;https://x.test/guide&quot;&gt;the guide&lt;/a&gt;.&lt;/p&gt;"
    );
    expect(xml).toContain("src=&quot;https://x.test/images/d.png&quot;");
  });

  it("leaves the content out unless asked, and the modules' namespaces with it", async () => {
    const project = await scanFixture({
      ...SITE,
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" } };\n',
      "docs/blog/a.md": "---\ntitle: A\ntype: blog\n---\n\nBody.\n",
      "docs/blog/b.md": "---\ntitle: B\ntype: blog\n---\n\nBody.\n",
      "docs/blog/c.md": "---\ntitle: C\ntype: blog\n---\n\nBody.\n",
    });
    const [feed] = buildRssFeeds(project, await buildFeedMarkdown(project));
    expect(feed?.title).toBe("Documentation — Blog");
    // SAFETY: the fixture's posts always yield the blog's feed.
    const xml = renderRssFeed(feed as RssFeed);
    expect(xml).toContain(
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">'
    );
    expect(xml).not.toContain("content:encoded");
    expect(xml).not.toContain("dc:creator");
  });

  it("lists the default locale's posts only", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" }, i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };\n',
      "docs/en/blog/a.md": "---\ntitle: A\ntype: blog\n---\n\nBody.\n",
      "docs/en/index.md": "---\ntitle: Home\n---\n\nHome.\n",
      "docs/fr/blog/a.md": "---\ntitle: A fr\ntype: blog\n---\n\nCorps.\n",
      "docs/fr/index.md": "---\ntitle: Accueil\n---\n\nAccueil.\n",
    });
    const [feed] = buildRssFeeds(project);
    expect(feed?.items.map((item) => item.title)).toEqual(["A"]);
  });
});

describe("the blog elsewhere", () => {
  it("lists the index and tag pages in the sitemap", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    const xml = buildSitemapFiles(project)?.[0]?.xml ?? "";
    expect(xml).toContain("<loc>https://x.test/blog</loc>");
    expect(xml).toContain("<loc>https://x.test/blog/tags/go</loc>");
    expect(xml).toContain("<loc>https://x.test/blog/tags/rust</loc>");
    expect(xml).not.toContain("tags/secret");
  });

  it("carries the posts, the index's tags, and the sidebar widths in the page data", async () => {
    const project = await scanFixture({ ...SITE, "blume.config.ts": CONFIG });
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.sidebarWidths).toStrictEqual({
      blog: "20rem",
      changelog: "18rem",
    });
    expect(data.blog.tags).toStrictEqual([
      { count: 2, label: "Go", slug: "go" },
      { count: 1, label: "Rust", slug: "rust" },
    ]);
    expect(
      data.blog.posts.map((post: { route: string }) => post.route)
    ).toEqual(["/blog/d", "/blog/a", "/blog/b", "/blog/c"]);
    expect(data.ui.blog.title).toBe("Notes");
  });

  it("drops a cover's local file from the page data, and sets no widths unasked", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ncover: /c.png\n---\n\nBody.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.blog.posts[0].cover).toStrictEqual({ alt: "A", src: "/c.png" });
    expect(data.sidebarWidths).toStrictEqual({});
  });

  it("emits a post's tags as its JSON-LD keywords", () => {
    const graph = buildStructuredData({
      breadcrumbs: [],
      keywords: ["Go", "Rust"],
      pageType: "blog",
      route: "/blog/a",
      siteName: "Acme",
      siteUrl: "https://x.test",
      title: "A",
    });
    // SAFETY: buildStructuredData always returns a `@graph` array of nodes.
    const nodes = graph["@graph"] as JsonLdNode[];
    const page = nodes.find((node) => node["@type"] === "BlogPosting");
    expect(page?.keywords).toEqual(["Go", "Rust"]);
    const untagged = buildStructuredData({
      breadcrumbs: [],
      keywords: [],
      pageType: "blog",
      route: "/blog/a",
      siteName: "Acme",
      siteUrl: "https://x.test",
      title: "A",
    });
    // SAFETY: as above.
    const plain = untagged["@graph"] as JsonLdNode[];
    expect(
      plain.find((node) => node["@type"] === "BlogPosting")
    ).not.toHaveProperty("keywords");
  });
});
