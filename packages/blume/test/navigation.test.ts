import { describe, expect, it } from "bun:test";

import { buildNavigation } from "../src/core/navigation.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
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

  it("hoists loose pages above groups in flat display", () => {
    const nav = buildNavigation(
      [
        page("provider/biome.md", "/provider/biome", "Biome"),
        page("rules.md", "/rules", "Rules"),
        page("setup.md", "/setup", "Setup"),
      ],
      { folderMeta: empty }
    );
    // Alphabetically "Provider" sorts before "Rules"/"Setup", but a loose page
    // after a flat group header would read as that group's child.
    expect(labels(nav.sidebar)).toStrictEqual(["Rules", "Setup", "Provider"]);
  });

  it("hoists pages recursively inside nested flat groups", () => {
    const nav = buildNavigation(
      [
        page("guide/advanced/deep.md", "/guide/advanced/deep", "Deep"),
        page("guide/zz-usage.md", "/guide/usage", "Usage"),
      ],
      { folderMeta: empty }
    );
    const guide = asGroup(nav.sidebar[0]);
    expect(labels(guide.children)).toStrictEqual(["Usage", "Advanced"]);
  });

  it("keeps file order and stamps groups when display is not flat", () => {
    const nav = buildNavigation(
      [
        page("provider/biome.md", "/provider/biome", "Biome"),
        page("rules.md", "/rules", "Rules"),
      ],
      { display: "group", folderMeta: empty }
    );
    // Collapsible groups are unambiguous rows; no hoisting needed.
    expect(labels(nav.sidebar)).toStrictEqual(["Provider", "Rules"]);
    expect(asGroup(nav.sidebar[0]).display).toBe("group");
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

describe("buildNavigation — group route paths", () => {
  it("keeps the folder route when the index page is inserted first", () => {
    // index.mdx sorts before its siblings, and an index page's route has no
    // page segment to drop — the group used to get "/" and tab scoping broke.
    const nav = buildNavigation(
      [
        page("guides/index.mdx", "/guides", "Guide Home"),
        page("guides/quickstart.mdx", "/guides/quickstart", "Quickstart"),
      ],
      { folderMeta: empty }
    );
    expect(asGroup(nav.sidebar[0]).path).toBe("/guides");
  });

  it("paths nested groups from a nested index page", () => {
    const nav = buildNavigation([page("a/b/index.mdx", "/a/b", "B Home")], {
      folderMeta: empty,
    });
    const a = asGroup(nav.sidebar[0]);
    expect(a.path).toBe("/a");
    expect(asGroup(a.children[0]).path).toBe("/a/b");
  });

  it("skips (group) folders when mapping dirs to route segments", () => {
    const nav = buildNavigation(
      [page("(main)/guides/setup.mdx", "/guides/setup", "Setup")],
      { folderMeta: empty }
    );
    const main = asGroup(nav.sidebar[0]);
    // The wrapper group contributes no route segment and spans the root.
    expect(main.path).toBe("/");
    expect(asGroup(main.children[0]).path).toBe("/guides");
  });

  it("right-aligns a locale/base route prefix onto the folder segments", () => {
    const nav = buildNavigation(
      [
        page("guides/index.mdx", "/fr/guides", "Accueil"),
        page("guides/setup.mdx", "/fr/guides/setup", "Setup"),
      ],
      { folderMeta: empty }
    );
    expect(asGroup(nav.sidebar[0]).path).toBe("/fr/guides");
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

  it("normalizes a leading-slash /index ref to the root route", () => {
    // "/index" used to trim to "" and emit a link to nowhere.
    const nav = buildNavigation(pages, {
      folderMeta: empty,
      sidebar: ["/index"],
    });
    const home = asPage(nav.sidebar[0]);
    expect(home.route).toBe("/");
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

  it("passes featured links through on both build paths", () => {
    const featured = [
      { href: "https://blog.example.com", icon: "newspaper", label: "Blog" },
      { href: "/contact", label: "Contact" },
    ];
    // Config-sidebar path.
    expect(
      buildNavigation(pages, { featured, folderMeta: empty, sidebar: [] })
        .featured
    ).toStrictEqual(featured);
    // Generated (filesystem) path.
    expect(
      buildNavigation(pages, { featured, folderMeta: empty }).featured
    ).toStrictEqual(featured);
    // Defaults to empty when omitted.
    expect(
      buildNavigation(pages, { folderMeta: empty }).featured
    ).toStrictEqual([]);
  });

  it("resolves a group's root ref to a real page route", () => {
    const sidebar: SidebarItemConfig[] = [
      { items: ["/bar"], label: "Group", root: "/foo" },
    ];
    const nav = buildNavigation(pages, { folderMeta: empty, sidebar });
    const group = asGroup(nav.sidebar[0]);
    // routeForRef maps the ref through byRoute to the page's route.
    expect(group.route).toBe("/foo");
  });

  it("stamps the global display on config groups unless overridden", () => {
    const sidebar: SidebarItemConfig[] = [
      { items: ["/bar"], label: "Drill" },
      { display: "flat", items: ["/foo"], label: "Flat" },
    ];
    const nav = buildNavigation(pages, {
      display: "page",
      folderMeta: empty,
      sidebar,
    });
    expect(asGroup(nav.sidebar[0]).display).toBe("page");
    expect(asGroup(nav.sidebar[1]).display).toBe("flat");
  });

  it("renders a root-only item as a page, matched or unmatched", () => {
    const sidebar: SidebarItemConfig[] = [
      { label: "Matched", root: "/foo" },
      { label: "Unmatched", root: "/missing" },
    ];
    const nav = buildNavigation(pages, { folderMeta: empty, sidebar });

    const matched = asPage(nav.sidebar[0]);
    expect(matched.label).toBe("Matched");
    expect(matched.route).toBe("/foo");
    expect(matched.pageId).toBe("foo.md");

    const unmatched = asPage(nav.sidebar[1]);
    expect(unmatched.route).toBe("/missing");
    expect(unmatched.pageId).toBe("");
  });
});

describe("navigation.sidebar config schema", () => {
  it("defaults to flat display with no explicit items", () => {
    const config = blumeConfigSchema.parse({});
    expect(config.navigation.sidebar).toStrictEqual({ display: "flat" });
  });

  it("normalizes a bare array to { display: 'flat', items }", () => {
    const config = blumeConfigSchema.parse({
      navigation: { sidebar: ["intro"] },
    });
    expect(config.navigation.sidebar).toStrictEqual({
      display: "flat",
      items: ["intro"],
    });
  });

  it("accepts an object with a global display mode", () => {
    const config = blumeConfigSchema.parse({
      navigation: { sidebar: { display: "group" } },
    });
    expect(config.navigation.sidebar).toStrictEqual({ display: "group" });
  });
});
