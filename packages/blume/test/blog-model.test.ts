import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { blogCoverSources, blogPosts } from "../src/core/blog-posts.ts";
import {
  adjacentPosts,
  authorEntries,
  authorInitials,
  blogTagRoute,
  blogTagRoutes,
  blogTags,
  blogTagSlug,
  coverEntry,
  datedSidebarGroups,
  hasBlogIndex,
  indexedPosts,
  postTags,
  RELATED_POSTS,
  relatedPosts,
  withBlogIndexText,
} from "../src/core/blog.ts";
import type { BlogPost } from "../src/core/blog.ts";
import type { BlogConfig } from "../src/core/config-input.ts";
import { collectContentAssets } from "../src/core/content-assets.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";
import { postText } from "../src/core/post-text.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { PageMetaInput } from "../src/core/schema.ts";
import type { PageRecord } from "../src/core/types.ts";
import { UI_PACKS } from "../src/core/ui-packs/index.ts";

/**
 * The blog's model: what a post's excerpt, reading time, tags, authors, and
 * cover are, and the policy every surface lists posts by — the index, the tag
 * pages, a post's neighbors and related posts.
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
  const root = await mkdtemp(join(tmpdir(), "blume-blog-model-"));
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

// A 1x1 PNG, so a relative image reference resolves to a real file.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const post = (over: Partial<BlogPost> = {}): BlogPost => ({
  authors: [],
  cover: null,
  date: null,
  excerpt: null,
  fallback: false,
  hidden: false,
  locale: "en",
  readingTime: 1,
  route: "/blog/a",
  tags: [],
  title: "A",
  version: "",
  ...over,
});

const tagged = (...labels: string[]) => postTags(labels);

/** A January 2026 day as a post's ISO date. */
const dated = (day: string) => `2026-01-${day}T00:00:00.000Z`;

// SAFETY: only the fields the listing policy reads; the rest of PageRecord is
// immaterial to it.
const scannedPage = (meta: PageMetaInput, extra: Partial<PageRecord> = {}) =>
  ({
    contentType: meta.type ?? "doc",
    locale: "en",
    meta: pageMetaSchema.parse(meta),
    version: "",
    ...extra,
  }) as PageRecord;

/** A config with two locales and the given `blog` settings. */
const localizedConfig = (blog?: BlogConfig) =>
  blumeConfigSchema.parse({
    blog,
    i18n: {
      defaultLocale: "en",
      locales: [
        { code: "en", label: "English" },
        { code: "sv", label: "Svenska" },
      ],
    },
  });

describe("postText", () => {
  it("takes the first paragraph with text, as plain words", () => {
    const text = postText(
      "# Heading\n\n![Diagram](./a.png)\n\n<div>raw</div>\n\nThe **first** [real](/x) paragraph with `code`\nand a second line.\n\nThe second paragraph.\n",
      "md"
    );
    expect(text.excerpt).toBe(
      "The first real paragraph with code and a second line."
    );
  });

  it("keeps words apart across a hard line break or a <br> tag", () => {
    expect(postText("One  \ntwo\n", "md").excerpt).toBe("One two");
    expect(postText("One<br />two\n", "md").excerpt).toBe("One two");
    // A word split across a link or emphasis stays one word.
    expect(postText("See [`foo`'s docs](/x) now.\n", "md").excerpt).toBe(
      "See foo's docs now."
    );
    expect(
      postText("A **bold *it*alic** word and ~~del~~eted.\n", "mdx").excerpt
    ).toBe("A bold italic word and deleted.");
    expect(postText("One<br/>two\n", "mdx").excerpt).toBe("One two");
  });

  it("reads MDX: imports, expressions, and components are not prose", () => {
    const text = postText(
      'import X from "./x.ts";\n\n{props.x}\n\n<Callout>Inside</Callout>\n\nOpening <Badge>new</Badge> words.\n',
      "mdx"
    );
    expect(text.excerpt).toBe("Opening new words.");
  });

  it("reads an MDX body the MDX grammar rejects as Markdown", () => {
    const text = postText("<!-- a comment -->\n\nStill words.\n", "mdx");
    expect(text.excerpt).toBe("Still words.");
  });

  it("passes over a `:::` directive the Markdown parser reads as a paragraph", () => {
    expect(
      postText(":::note\nA note.\n:::\n\nThe intro.\n", "md").excerpt
    ).toBe("The intro.");
  });

  it("reads past a rule, which holds no words", () => {
    expect(postText("***\n\nAfter the rule.\n", "md").excerpt).toBe(
      "After the rule."
    );
  });

  it("has no excerpt without a paragraph", () => {
    expect(postText("# Only a heading\n", "md").excerpt).toBeUndefined();
  });

  it("cuts a long excerpt at the last whole word", () => {
    const excerpt = postText(`${"word ".repeat(100)}\n`, "md").excerpt ?? "";
    expect([...excerpt].length).toBeLessThanOrEqual(300);
    expect(excerpt.endsWith("word…")).toBe(true);
  });

  it("cuts a long excerpt with no space at the limit", () => {
    const excerpt = postText(`${"a".repeat(400)}\n`, "md").excerpt ?? "";
    expect(excerpt).toBe(`${"a".repeat(299)}…`);
  });

  it("estimates the reading time at 200 words a minute, at least one", () => {
    expect(postText("Short.\n", "md").readingTime).toBe(1);
    expect(postText(`${"word ".repeat(1000)}\n`, "md").readingTime).toBe(5);
    // Code counts as reading too.
    expect(
      postText(`\`\`\`\n${"token ".repeat(600)}\n\`\`\`\n`, "md").readingTime
    ).toBe(3);
  });
});

describe("tags", () => {
  it("slugs a tag by its letters and digits, in any script", () => {
    expect(blogTagSlug("Azure DevOps")).toBe("azure-devops");
    expect(blogTagSlug("Säkerhet & drift")).toBe("säkerhet-drift");
    // Combining marks stay with their letters.
    expect(blogTagSlug("हिन्दी")).toBe("हिन्दी");
    expect(blogTagSlug("  --C# ")).toBe("c");
    expect(blogTagSlug("🎉")).toBe("tag");
    expect(blogTagRoute("azure-devops")).toBe("/blog/tags/azure-devops");
  });

  it("keeps each of a post's tags once, spelled as it first appears", () => {
    expect(tagged("DevOps", "devops", "Go")).toStrictEqual([
      { label: "DevOps", slug: "devops" },
      { label: "Go", slug: "go" },
    ]);
    expect(postTags()).toStrictEqual([]);
  });

  it("counts tags across posts, most used first, then by label", () => {
    expect(
      blogTags([
        post({ tags: tagged("Go", "Rust") }),
        post({ tags: tagged("rust") }),
        post({ tags: tagged("Ada") }),
      ])
    ).toStrictEqual([
      { count: 2, label: "Rust", slug: "rust" },
      { count: 1, label: "Ada", slug: "ada" },
      { count: 1, label: "Go", slug: "go" },
    ]);
  });
});

describe("front matter readers", () => {
  it("reads every form of authors", () => {
    expect(authorEntries()).toStrictEqual([]);
    expect(authorEntries("Ada")).toStrictEqual([{ name: "Ada" }]);
    // A blank name credits no one.
    expect(authorEntries(["", { name: "  " }, "Ada"])).toStrictEqual([
      { name: "Ada" },
    ]);
    expect(
      authorEntries([
        "Ada",
        { image: "./ada.png", name: "Ada L" },
        { avatar: "/g.png", name: "Grace", url: "https://g.test" },
        { name: "Plain" },
      ])
    ).toStrictEqual([
      { name: "Ada" },
      { avatar: "./ada.png", name: "Ada L" },
      { avatar: "/g.png", name: "Grace", url: "https://g.test" },
      { name: "Plain" },
    ]);
  });

  it("reads both forms of cover", () => {
    expect(coverEntry()).toBeNull();
    expect(coverEntry("./a.png")).toStrictEqual({ src: "./a.png" });
    expect(coverEntry({ alt: "A", src: "./a.png" })).toStrictEqual({
      alt: "A",
      src: "./a.png",
    });
  });

  it("accepts tags and a cover, and refuses an empty tag", () => {
    expect(
      pageMetaSchema.parse({ cover: { src: "/c.png" }, tags: [" Go "] })
    ).toMatchObject({ cover: { src: "/c.png" }, tags: ["Go"] });
    expect(pageMetaSchema.safeParse({ tags: [" "] }).success).toBe(false);
    expect(pageMetaSchema.safeParse({ cover: "" }).success).toBe(false);
  });

  it("writes up to two initials", () => {
    expect(authorInitials("Ada King Lovelace")).toBe("AL");
    expect(authorInitials("grace")).toBe("G");
    // The same on every build machine, a Turkish one included.
    expect(authorInitials("ilse irving")).toBe("II");
    expect(authorInitials("😀 Smile")).toBe("😀S");
    expect(authorInitials("Ada Lovelace (Acme)")).toBe("AA");
    expect(authorInitials("“Grace” —")).toBe("G");
    expect(authorInitials("   ")).toBe("");
  });
});

describe("listing policy", () => {
  it("indexes the current docs' own posts in the default locale", () => {
    const posts = [
      post({ route: "/blog/a" }),
      post({ hidden: true, route: "/blog/hidden" }),
      post({ fallback: true, locale: "fr", route: "/fr/blog/a" }),
      post({ locale: "fr", route: "/fr/blog/b" }),
      post({ route: "/v1/blog/a", version: "v1" }),
    ];
    expect(indexedPosts(posts, "en").map((entry) => entry.route)).toEqual([
      "/blog/a",
    ]);
    expect(indexedPosts(posts, null).map((entry) => entry.route)).toEqual([
      "/blog/a",
      "/fr/blog/b",
    ]);
  });

  it("links the newer and older post of the same locale and version", () => {
    const posts = [
      post({ date: dated("03"), route: "/blog/c" }),
      post({ date: dated("02"), hidden: true, route: "/blog/hidden" }),
      post({ date: dated("02"), locale: "fr", route: "/fr/blog/x" }),
      post({ date: dated("02"), route: "/blog/b" }),
      post({ date: dated("01"), route: "/blog/a" }),
      post({ route: "/blog/undated" }),
    ];
    const routes = (route: string) => {
      const adjacent = adjacentPosts(posts, route);
      return adjacent
        ? [adjacent.newer?.route ?? null, adjacent.older?.route ?? null]
        : null;
    };
    expect(routes("/blog/c")).toEqual([null, "/blog/b"]);
    expect(routes("/blog/b")).toEqual(["/blog/c", "/blog/a"]);
    // The oldest dated post links no undated one: those page as the sidebar
    // orders them, and so does a post it can't find.
    expect(routes("/blog/a")).toEqual(["/blog/b", null]);
    expect(routes("/blog/undated")).toBeNull();
    expect(routes("/docs/nope")).toBeNull();
    // A hidden post isn't in the sequence, and links nowhere itself.
    expect(routes("/blog/hidden")).toEqual([null, null]);
  });

  it("suggests the posts that share the most tags, newest first among equals", () => {
    const posts = [
      post({ route: "/blog/a", tags: tagged("Go", "Rust", "Zig") }),
      post({ route: "/blog/b", tags: tagged("Go") }),
      post({ route: "/blog/c", tags: tagged("Go", "Rust") }),
      post({ route: "/blog/d", tags: tagged("go") }),
      post({ route: "/blog/e", tags: tagged("Go") }),
      post({ hidden: true, route: "/blog/f", tags: tagged("Go", "Rust") }),
      post({ locale: "fr", route: "/fr/blog/g", tags: tagged("Go") }),
      post({ route: "/blog/h", tags: tagged("Elm") }),
    ];
    expect(relatedPosts(posts, "/blog/a").map((entry) => entry.route)).toEqual([
      "/blog/c",
      "/blog/b",
      "/blog/d",
    ]);
    expect(RELATED_POSTS).toBe(3);
    expect(relatedPosts(posts, "/blog/h")).toEqual([]);
    expect(relatedPosts([post()], "/blog/a")).toEqual([]);
    expect(relatedPosts(posts, "/nope")).toEqual([]);
  });

  it("finds the index and its tag routes on the scanned pages", () => {
    const pages = [
      scannedPage({ tags: ["Go", "Rust"], type: "blog" }),
      scannedPage({ hidden: true, tags: ["Hidden"], type: "blog" }),
      scannedPage({ draft: true, tags: ["Draft"], type: "blog" }),
      scannedPage({ tags: ["Copy"], type: "blog" }, { fallback: true }),
      scannedPage({ tags: ["Docs"] }),
    ];
    expect(hasBlogIndex(pages, "en")).toBe(true);
    expect(hasBlogIndex(pages.slice(1, 3), "en")).toBe(false);
    // Only another locale's or an archived version's posts: nothing to list.
    expect(
      hasBlogIndex(
        [
          scannedPage({ type: "blog" }, { locale: "fr" }),
          scannedPage({ type: "blog" }, { version: "v1" }),
        ],
        "en"
      )
    ).toBe(false);
    expect(blogTagRoutes(pages, "en")).toEqual([
      "/blog/tags/go",
      "/blog/tags/rust",
    ]);
  });
});

describe("config", () => {
  it("groups blog posts by year and changelog entries not at all, by default", () => {
    const config = blumeConfigSchema.parse({});
    expect(datedSidebarGroups(config)).toStrictEqual({ blog: "year" });
    expect(
      datedSidebarGroups(
        blumeConfigSchema.parse({
          blog: { sidebar: { groupBy: false } },
          changelog: { sidebar: { groupBy: "month" } },
        })
      )
    ).toStrictEqual({ changelog: "month" });
  });

  it("takes a CSS length for the sidebar width", () => {
    expect(
      blumeConfigSchema.parse({ blog: { sidebar: { width: "20rem" } } }).blog
        ?.sidebar.width
    ).toBe("20rem");
    expect(
      blumeConfigSchema.safeParse({ blog: { sidebar: { width: "wide" } } })
        .success
    ).toBe(false);
  });

  it("titles the index from the config, a per-locale map, or the UI strings", () => {
    const config = localizedConfig;
    expect(withBlogIndexText(config(), EN_UI).blog.title).toBe("Blog");
    expect(
      withBlogIndexText(config({ title: "Notes" }), EN_UI).blog.title
    ).toBe("Notes");
    const localized = config({
      description: { en: "News", sv: "Nyheter" },
      title: { en: "Blog", sv: "Blogg" },
    });
    expect(withBlogIndexText(localized, EN_UI, "sv").blog).toMatchObject({
      description: "Nyheter",
      title: "Blogg",
    });
  });
});

describe("blogPosts", () => {
  it("builds each post's date, excerpt, authors, tags, and cover", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { base: "/sub", site: "https://x.test" } };\n',
      "docs/blog/a.md": [
        "---",
        "title: A",
        "type: blog",
        "date: 2026-03-04",
        "tags: [Go, go, Rust]",
        "authors:",
        "  - name: Ada",
        "    avatar: ./ada.png",
        "    url: https://ada.test",
        "  - name: Hedy",
        "    url: /team/hedy",
        "  - name: Grace",
        "    avatar: ./missing.png",
        "  - Linus",
        "cover: ./cover.png",
        "---",
        "",
        "The first paragraph.",
        "",
      ].join("\n"),
      "docs/blog/ada.png": PNG.toString("binary"),
      "docs/blog/b.md": [
        "---",
        "title: B",
        "type: blog",
        "date: 2026-03-04",
        "description: Described.",
        "cover:",
        "  src: /images/my%20b.png?v=2",
        "  alt: Bee",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "docs/blog/c.md":
        "---\ntitle: C\ntype: blog\nseo:\n  description: From SEO.\ncover: https://img.test/c.png\n---\n\n# Only a heading\n",
      "docs/blog/cover.png": PNG.toString("binary"),
      "docs/blog/d.md":
        "---\ntitle: D\ntype: blog\ndate: 2025-01-01\ncover: ./nope.png\n---\n\n# Heading\n",
      "docs/guide.md": "---\ntitle: Guide\n---\n\nNot a post.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const posts = blogPosts(project);
    // Newest first, a same-day tie in title order, undated last.
    expect(posts.map((entry) => entry.title)).toEqual(["A", "B", "D", "C"]);
    const [a, b, d, c] = posts;
    expect(a).toMatchObject({
      authors: [
        {
          avatar: "/sub/blume-assets/content/docs/blog/ada.png",
          name: "Ada",
          url: "https://ada.test",
        },
        { name: "Hedy", url: "/sub/team/hedy" },
        { name: "Grace" },
        { name: "Linus" },
      ],
      cover: {
        alt: "A",
        src: "/sub/blume-assets/content/docs/blog/cover.png",
      },
      date: "2026-03-04T00:00:00.000Z",
      excerpt: "The first paragraph.",
      readingTime: 1,
      tags: [
        { label: "Go", slug: "go" },
        { label: "Rust", slug: "rust" },
      ],
    });
    expect(a?.cover?.file).toBe(
      join(project.context.root, "docs/blog/cover.png")
    );
    expect(b).toMatchObject({
      cover: {
        alt: "Bee",
        // The file on disk, its name decoded and the query set aside.
        file: join(project.context.root, "public/images/my b.png"),
        src: "/sub/images/my%20b.png?v=2",
      },
      excerpt: "Described.",
    });
    expect(c).toMatchObject({
      cover: { alt: "C", src: "https://img.test/c.png" },
      date: null,
      excerpt: "From SEO.",
    });
    // A relative cover that names no file is left off.
    expect(d?.cover).toBeNull();
    expect(d?.excerpt).toBeNull();

    expect(blogCoverSources(posts)).toStrictEqual({
      "/blog/a": join(project.context.root, "docs/blog/cover.png"),
      "/blog/b": join(project.context.root, "public/images/my b.png"),
      "/blog/c": "https://img.test/c.png",
    });
    // A protocol-relative cover reaches the OG card over HTTPS.
    expect(
      blogCoverSources([
        post({
          cover: { alt: "X", src: "//cdn.test/x.png" },
          route: "/blog/x",
        }),
      ])
    ).toStrictEqual({ "/blog/x": "https://cdn.test/x.png" });

    // The served images beside a post include its front matter's.
    const assets = await collectContentAssets(project);
    expect(Object.keys(assets).toSorted()).toEqual([
      "docs/blog/ada.png",
      "docs/blog/cover.png",
    ]);
  });

  it("passes a data URI through, and leaves a staged post's relative images off", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md":
        "---\ntitle: A\ntype: blog\ncover: data:image/png;base64,AAAA\n---\n\nBody.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const [first] = blogPosts(project);
    expect(first?.cover).toStrictEqual({
      alt: "A",
      src: "data:image/png;base64,AAAA",
    });
    const staged = blogPosts({
      ...project,
      graph: {
        pages: project.graph.pages.map((page) => ({
          ...page,
          meta: { ...page.meta, cover: "./a.png" },
          post: undefined,
          sourcePath: undefined,
        })),
      },
    });
    expect(staged[0]).toMatchObject({ cover: null, readingTime: 1 });
  });
});

describe("the built-in UI packs", () => {
  it("translate every blog string, placeholders kept", () => {
    for (const [code, pack] of Object.entries(UI_PACKS)) {
      const strings = new Map(Object.entries(pack.blog ?? {}));
      for (const key of Object.keys(EN_UI.blog)) {
        expect(
          strings.get(key),
          `pack "${code}" misses blog.${key}`
        ).toBeTruthy();
      }
      expect(pack.blog?.readingTime).toContain("{minutes}");
      expect(pack.blog?.tagged).toContain("{tag}");
    }
  });
});
