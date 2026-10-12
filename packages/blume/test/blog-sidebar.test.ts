import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildLlmsIndex } from "../src/ai/llms.ts";
import { findBreadcrumbs } from "../src/components/layout/nav-utils.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { NavNode } from "../src/core/types.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";

/**
 * Dated entries in the sidebar: blog posts fold into collapsible years by
 * default, changelog entries when asked; their titles wrap; and the surfaces
 * that read the tree — breadcrumbs, search sections, llms.txt — read through
 * a year group to the section it sits in.
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
  const root = await mkdtemp(join(tmpdir(), "blume-blog-sidebar-"));
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

const entry = (
  type: string,
  title: string,
  date?: string,
  extra = ""
): string =>
  `---\ntitle: ${title}\ntype: ${type}\n${date ? `date: ${date}\n` : ""}${extra}---\n\nBody.\n`;

const POSTS = {
  "docs/blog/a.md": entry("blog", "Newest", "2026-05-01"),
  "docs/blog/b.md": entry("blog", "Older this year", "2026-01-02"),
  "docs/blog/c.md": entry("blog", "Last year", "2025-12-31"),
  "docs/blog/d.md": entry("blog", "Undated"),
  "docs/blog/e.md": entry(
    "blog",
    "Pinned",
    "2024-01-01",
    "sidebar:\n  order: 1\n"
  ),
  "docs/blog/index.md": "---\ntitle: Blog home\n---\n\nThe blog.\n",
  "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
};

/** A group's children as labels, a year's as `year: [titles]`. */
const outline = (nodes: NavNode[]): unknown[] =>
  nodes.map((node) =>
    node.kind === "page" ? node.label : { [node.label]: outline(node.children) }
  );

const blogGroup = (
  project: BlumeProject
): Extract<NavNode, { kind: "group" }> => {
  const group = project.graph.navigation.sidebar.find(
    (node) => node.kind === "group" && node.label === "Blog"
  );
  if (group?.kind !== "group") {
    throw new Error("no Blog group");
  }
  return group;
};

describe("dated entries in the sidebar", () => {
  it("folds blog posts into years, newest first, leaving undated and hand-ordered posts loose", async () => {
    const project = await scanFixture({
      ...POSTS,
      "blume.config.ts": "export default {};\n",
    });
    const blog = blogGroup(project);
    // A hand-ordered post keeps its `sidebar.order`, which sorts after the
    // dated entries' derived order, as in the changelog.
    expect(outline(blog.children)).toEqual([
      "Blog home",
      { 2026: ["Newest", "Older this year"] },
      { 2025: ["Last year"] },
      "Pinned",
      "Undated",
    ]);
    const [, year] = blog.children;
    expect(year).toMatchObject({
      display: "group",
      kind: "group",
      period: "year",
    });
    // Every blog post's row wraps, grouped or not; the index page's doesn't.
    expect(
      blog.children.map((node) => node.kind === "page" && node.wrap)
    ).toEqual([undefined, false, false, true, true]);
  });

  it("warns of two undated posts ranked alike, as of any two pages", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/01-a.md": entry("blog", "A"),
      "docs/blog/01-b.md": entry("blog", "B"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    // A changelog entry's numeric prefix is usually a date, not a rank; a
    // post's still ranks it.
    expect(
      project.diagnostics.filter(
        (diagnostic) => diagnostic.code === "BLUME_DUPLICATE_SIDEBAR_ORDER"
      )
    ).toHaveLength(1);
  });

  it("lists a post dated before 1970 ahead of undated ones, flat or grouped", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        "export default { blog: { sidebar: { groupBy: false } } };\n",
      "docs/blog/01-intro.md": entry("blog", "Numbered"),
      "docs/blog/new.md": entry("blog", "New", "2026-05-01"),
      "docs/blog/old.md": entry("blog", "Old", "1969-05-01"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(outline(blogGroup(project).children)).toEqual([
      "New",
      "Old",
      "Numbered",
    ]);
  });

  it("gives each period one group in a folder of blog posts and changelog entries", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { changelog: { sidebar: { groupBy: "month" } } };\n',
      "docs/blog/a.md": entry("blog", "A", "2026-05-01"),
      "docs/blog/b.md": entry("blog", "B", "2026-03-01"),
      "docs/blog/c.md": entry("changelog", "C", "2026-04-01"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(outline(blogGroup(project).children)).toEqual([
      { 2026: ["A", "B"] },
      { "April 2026": ["C"] },
    ]);
    expect(
      project.diagnostics.filter(
        (diagnostic) => diagnostic.code === "BLUME_NAV_DUPLICATE_LABEL"
      )
    ).toEqual([]);
  });

  it("leaves loose posts be in a year a sibling folder already is", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/2026/c.md": entry("blog", "C", "2026-01-01"),
      "docs/blog/2026/d.md": entry("blog", "D", "2026-02-01"),
      "docs/blog/a.md": entry("blog", "A", "2026-03-01"),
      "docs/blog/b.md": entry("blog", "B", "2025-03-01"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    // No second "2026" beside the folder, and so no duplicate label.
    expect(outline(blogGroup(project).children)).toEqual([
      "A",
      { 2025: ["B"] },
      { 2026: ["D", "C"] },
    ]);
    expect(
      project.diagnostics.filter(
        (diagnostic) => diagnostic.code === "BLUME_NAV_DUPLICATE_LABEL"
      )
    ).toEqual([]);
  });

  it("lists a page beside the posts after them, whatever its order", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md": entry("blog", "A", "2026-03-01"),
      "docs/blog/about.md":
        "---\ntitle: About\nsidebar:\n  order: 1\n---\n\nAbout.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    // As in a changelog folder: the dated entries first.
    expect(outline(blogGroup(project).children)).toEqual([
      { 2026: ["A"] },
      "About",
    ]);
  });

  it("knows a retitled period folder by its name", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/2026/c.md": entry("blog", "C", "2026-01-01"),
      "docs/blog/2026/meta.ts": 'export default { title: "This year" };\n',
      "docs/blog/a.md": entry("blog", "A", "2026-03-01"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(outline(blogGroup(project).children)).toEqual([
      "A",
      { "This year": ["C"] },
    ]);
  });

  it("orders same-day posts by title, as the index does", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/blog/a.md": entry(
        "blog",
        "Alpha",
        "2026-05-01",
        "sidebar:\n  label: Zeta\n"
      ),
      "docs/blog/b.md": entry("blog", "Beta", "2026-05-01"),
      "docs/blog/c.md": entry("changelog", "Gamma", "2026-05-01"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    // The changelog entry ties on its label, as it always has.
    expect(outline(blogGroup(project).children)).toEqual([
      { 2026: ["Zeta", "Beta"] },
      "Gamma",
    ]);
  });

  it("groups by month, labeled in the tree's language", async () => {
    const project = await scanFixture({
      ...POSTS,
      "blume.config.ts":
        'export default { blog: { sidebar: { groupBy: "month" } }, i18n: { defaultLocale: "sv", locales: [{ code: "sv", label: "Svenska" }] } };\n',
    });
    expect(outline(blogGroup(project).children)).toEqual([
      "Blog home",
      { "maj 2026": ["Newest"] },
      { "januari 2026": ["Older this year"] },
      { "december 2025": ["Last year"] },
      "Pinned",
      "Undated",
    ]);
  });

  it("lists blog posts flat when grouping is off, and groups the changelog when asked", async () => {
    const project = await scanFixture({
      ...POSTS,
      "blume.config.ts":
        'export default { blog: { sidebar: { groupBy: false } }, changelog: { sidebar: { groupBy: "year" } } };\n',
      "docs/changelog/v1.md": entry("changelog", "v1", "2025-02-01"),
      "docs/changelog/v2.md": entry("changelog", "v2", "2026-02-01"),
    });
    expect(outline(blogGroup(project).children)).toEqual([
      "Blog home",
      "Newest",
      "Older this year",
      "Last year",
      "Pinned",
      "Undated",
    ]);
    const changelog = project.graph.navigation.sidebar.find(
      (node) => node.label === "Changelog"
    );
    expect(changelog?.kind === "group" && outline(changelog.children)).toEqual([
      { 2026: ["v2"] },
      { 2025: ["v1"] },
    ]);
  });

  it("leaves changelog entries ungrouped by default", async () => {
    const project = await scanFixture({
      "blume.config.ts": "export default {};\n",
      "docs/changelog/v1.md": entry("changelog", "v1", "2025-02-01"),
      "docs/changelog/v2.md": entry("changelog", "v2", "2026-02-01"),
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    const changelog = project.graph.navigation.sidebar.find(
      (node) => node.label === "Changelog"
    );
    expect(changelog?.kind === "group" && outline(changelog.children)).toEqual([
      "v2",
      "v1",
    ]);
  });

  it("reads through a year group in breadcrumbs, search sections, and llms.txt", async () => {
    const project = await scanFixture({
      ...POSTS,
      "blume.config.ts":
        'export default { blog: { title: "Notes" }, deployment: { site: "https://x.test" } };\n',
      "docs/blog/a.md": entry(
        "blog",
        "Newest",
        "2026-05-01",
        "tags: [Go]\nsearch:\n  tags: [Lang, Go]\n"
      ),
    });
    const { sidebar } = project.graph.navigation;
    expect(
      findBreadcrumbs(sidebar, "/blog/a").map((crumb) => crumb.label)
    ).toEqual(["Blog", "Newest"]);
    const documents = await buildSearchDocuments(project);
    const newest = documents.find((doc) => doc.route === "/blog/a");
    // A post files under the blog, by its configured title, whatever folder
    // it sits in; its tags facet beside `search.tags`.
    expect(newest).toMatchObject({
      breadcrumb: ["Blog"],
      description: "Body.",
      section: "Notes",
      tags: ["Lang", "Go"],
    });
    expect(documents.find((doc) => doc.route === "/blog")?.section).toBe(
      "Blog"
    );
    const llms = buildLlmsIndex(project);
    expect(llms).not.toContain("### 2026");
    expect(llms).toContain(
      "## Blog\n\n- [Blog home](https://x.test/blog)\n- [Newest](https://x.test/blog/a): Body.\n- [Older this year](https://x.test/blog/b): Body.\n- [Last year](https://x.test/blog/c): Body.\n- [Pinned](https://x.test/blog/e): Body.\n- [Undated](https://x.test/blog/d): Body."
    );
  });

  it("lists a root-level year group with the loose pages in llms.txt", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://x.test" } };\n',
      "docs/a.md": entry("blog", "Post", "2026-05-01"),
      "docs/guides/setup.md": "---\ntitle: Setup\n---\n\nSet up.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
    });
    expect(outline(project.graph.navigation.sidebar)).toEqual([
      "Home",
      { 2026: ["Post"] },
      { Guides: ["Setup"] },
    ]);
    expect(buildLlmsIndex(project)).toContain(
      "## Docs\n\n- [Home](https://x.test/)\n- [Post](https://x.test/a): Body.\n\n## Guides"
    );
  });
});
