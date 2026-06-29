import { describe, expect, it } from "bun:test";

import { buildNavigation } from "../src/core/navigation.ts";
import { pageMetaSchema } from "../src/core/schema.ts";
import type { FolderMeta, SidebarItemConfig } from "../src/core/schema.ts";
import type { NavNode, PageRecord } from "../src/core/types.ts";

const page = (
  id: string,
  route: string,
  title: string,
  sidebar: Record<string, unknown> = {},
  draft = false
): PageRecord => ({
  contentType: "doc",
  format: "mdx",
  groups: [],
  headings: [],
  id,
  links: [],
  locale: "",
  meta: pageMetaSchema.parse({ draft, sidebar }),
  navPath: id,
  route,
  segments: [],
  source: { name: "filesystem", ref: id },
  sourcePath: `/abs/${id}`,
  title,
  translationKey: route,
});

const asGroup = (node: NavNode | undefined) => {
  if (!node || node.kind !== "group") {
    throw new Error("expected a group node");
  }
  return node;
};

const asPage = (node: NavNode | undefined) => {
  if (!node || node.kind !== "page") {
    throw new Error("expected a page node");
  }
  return node;
};

const labels = (nodes: NavNode[]): string[] => nodes.map((node) => node.label);

const empty = new Map<string, FolderMeta>();

describe("buildNavigation — filesystem sidebar", () => {
  it("nests pages into groups by directory and orders by numeric prefix", () => {
    const nav = buildNavigation(
      [
        page("01-intro.md", "/intro", "Intro"),
        page("guide/02-config.md", "/guide/config", "Config"),
        page("guide/01-setup.md", "/guide/setup", "Setup"),
        page("guide/index.md", "/guide", "Guide Home"),
      ],
      { folderMeta: empty }
    );

    expect(labels(nav.sidebar)).toStrictEqual(["Intro", "Guide"]);
    const guide = asGroup(nav.sidebar[1]);
    // index sorts first (−Infinity), then by numeric prefix.
    expect(labels(guide.children)).toStrictEqual([
      "Guide Home",
      "Setup",
      "Config",
    ]);
  });

  it("excludes pages hidden from the sidebar", () => {
    const nav = buildNavigation(
      [page("a.md", "/a", "A"), page("b.md", "/b", "B", { hidden: true })],
      { folderMeta: empty }
    );
    expect(labels(nav.sidebar)).toStrictEqual(["A"]);
  });

  it("applies sidebar label and badge overrides", () => {
    const nav = buildNavigation(
      [page("a.md", "/a", "Original", { badge: "New", label: "Custom" })],
      { folderMeta: empty }
    );
    const node = asPage(nav.sidebar[0]);
    expect(node.label).toBe("Custom");
    expect(node.badge).toBe("New");
    expect(node.route).toBe("/a");
  });

  it("honors an explicit sidebar.order over the filename", () => {
    const nav = buildNavigation(
      [
        page("a.md", "/a", "A", { order: 2 }),
        page("b.md", "/b", "B", { order: 1 }),
      ],
      { folderMeta: empty }
    );
    expect(labels(nav.sidebar)).toStrictEqual(["B", "A"]);
  });

  it("treats (group) folders as labeled groups, stripping the parens", () => {
    const nav = buildNavigation(
      [page("(legal)/privacy.md", "/privacy", "Privacy")],
      { folderMeta: empty }
    );
    const group = asGroup(nav.sidebar[0]);
    expect(group.label).toBe("Legal");
    expect(labels(group.children)).toStrictEqual(["Privacy"]);
  });

  it("applies folder meta: title, collapsed, and explicit page order", () => {
    const folderMeta = new Map<string, FolderMeta>([
      [
        "guide",
        {
          collapsed: true,
          order: 0,
          pages: ["beta", "alpha"],
          title: "Guides",
        },
      ],
    ]);
    const nav = buildNavigation(
      [
        page("guide/alpha.md", "/guide/alpha", "Alpha"),
        page("guide/beta.md", "/guide/beta", "Beta"),
      ],
      { folderMeta }
    );
    const group = asGroup(nav.sidebar[0]);
    expect(group.label).toBe("Guides");
    expect(group.collapsed).toBe(true);
    expect(labels(group.children)).toStrictEqual(["Beta", "Alpha"]);
  });
});

describe("buildNavigation — explicit config sidebar", () => {
  const pages = [
    page("index.md", "/", "Home"),
    page("foo.md", "/foo", "Foo"),
    page("bar.md", "/bar", "Bar"),
  ];

  it("resolves string refs, groups, and external links in order", () => {
    const sidebar: SidebarItemConfig[] = [
      "index",
      "/foo",
      { items: ["/bar"], label: "Group" },
      { href: "https://x.com", label: "External" },
    ];
    const nav = buildNavigation(pages, { folderMeta: empty, sidebar });

    expect(labels(nav.sidebar)).toStrictEqual([
      "Home",
      "Foo",
      "Group",
      "External",
    ]);
    expect(labels(asGroup(nav.sidebar[2]).children)).toStrictEqual(["Bar"]);
    const external = asPage(nav.sidebar[3]);
    expect(external.route).toBe("https://x.com");
    expect(external.pageId).toBe("");
  });

  it("normalizes index refs and drops refs with no matching page", () => {
    const sidebar: SidebarItemConfig[] = ["index", "foo/index", "/bar", "nope"];
    const nav = buildNavigation(pages, { folderMeta: empty, sidebar });
    // "foo/index" → /foo, "nope" → /nope (unmatched, dropped).
    expect(labels(nav.sidebar)).toStrictEqual(["Home", "Foo", "Bar"]);
  });

  it("passes tabs through unchanged", () => {
    const tabs = [{ label: "Docs", path: "/docs" }];
    const nav = buildNavigation(pages, {
      folderMeta: empty,
      sidebar: [],
      tabs,
    });
    expect(nav.tabs).toStrictEqual(tabs);
    expect(nav.sidebar).toStrictEqual([]);
  });
});
