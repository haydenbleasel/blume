import { describe, expect, it } from "bun:test";

import { buildNavigation } from "../src/core/navigation.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { FolderMeta, SidebarItemConfig } from "../src/core/schema.ts";
import type { Diagnostic, NavNode, PageRecord } from "../src/core/types.ts";

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
  // Mirrors deriveTitle's real behavior: an explicit frontmatter title always
  // equals the page's resolved title, which most fixtures want to simulate.
  meta: pageMetaSchema.parse({ draft, sidebar, title }),
  navPath: id,
  route,
  segments: [],
  source: { name: "filesystem", ref: id },
  sourcePath: `/abs/${id}`,
  title,
  translationKey: route,
});

const changelogPage = (
  ref: string,
  title: string,
  date: string
): PageRecord => ({
  contentType: "changelog",
  format: "md",
  groups: [],
  headings: [],
  id: `changelog/${ref}`,
  links: [],
  locale: "",
  meta: pageMetaSchema.parse({ date, type: "changelog" }),
  navPath: `changelog/${ref}`,
  route: `/changelog/${ref}`,
  segments: [],
  source: { name: "releases", ref },
  title,
  translationKey: `/changelog/${ref}`,
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

  it("hoists root pages above groups but not recursively when display is not flat", () => {
    const nav = buildNavigation(
      [
        page("provider/biome.md", "/provider/biome", "Biome"),
        page("guide/advanced/deep.md", "/guide/advanced/deep", "Deep"),
        page("guide/zz-usage.md", "/guide/usage", "Usage"),
        page("rules.md", "/rules", "Rules"),
      ],
      { display: "group", folderMeta: empty }
    );
    // Root-level loose pages hoist above groups in every display mode.
    expect(labels(nav.sidebar)).toStrictEqual(["Rules", "Guide", "Provider"]);
    expect(asGroup(nav.sidebar[1]).display).toBe("group");
    // But nested pages keep file order — collapsible groups are unambiguous rows.
    const guide = asGroup(nav.sidebar[1]);
    expect(labels(guide.children)).toStrictEqual(["Advanced", "Usage"]);
  });

  it("hoists loose pages above groups inside a tab-owned section", () => {
    // A prefixed content source (`prefix: "docs"`) nests every page under a
    // `/docs` group that a tab surfaces as the sidebar. Hoisting only the tree
    // root would leave that section's loose pages interleaved with its groups.
    const nav = buildNavigation(
      [
        page("docs/index.mdx", "/docs", "Overview"),
        page("docs/adapters/s3.mdx", "/docs/adapters/s3", "S3"),
        page("docs/faq.mdx", "/docs/faq", "FAQ"),
        page("docs/usage.mdx", "/docs/usage", "Usage"),
      ],
      {
        display: "group",
        folderMeta: empty,
        tabs: [{ label: "Docs", path: "/docs" }],
      }
    );
    const section = asGroup(nav.sidebar[0]);
    expect(section.path).toBe("/docs");
    // Loose pages come first (index still leads), then the group.
    expect(labels(section.children)).toStrictEqual([
      "Overview",
      "FAQ",
      "Usage",
      "Adapters",
    ]);
  });

  it("excludes the root tab from tab-section scoping under a basePath", () => {
    // A `path: "/"` tab spans the whole tree. Tab paths are rebased before
    // tab-section matching, so under `basePath: "/docs"` the root tab becomes
    // `/docs` — exactly a root-level `(group)` folder's routePath. It must
    // still be recognized as the root and not hoist that group's pages above
    // its subgroups (non-flat displays keep file order inside groups).
    const pages = [
      page("(intro)/alpha/one.md", "/docs/alpha/one", "One"),
      page("(intro)/zeta.md", "/docs/zeta", "Zeta"),
    ];
    const options = {
      display: "group" as const,
      folderMeta: empty,
      tabs: [{ label: "Docs", path: "/" }],
    };
    const based = buildNavigation(pages, { ...options, basePath: "/docs" });
    const baseless = buildNavigation(
      [
        page("(intro)/alpha/one.md", "/alpha/one", "One"),
        page("(intro)/zeta.md", "/zeta", "Zeta"),
      ],
      options
    );
    // The based sidebar must order exactly like the base-less one.
    expect(labels(asGroup(based.sidebar[0]).children)).toStrictEqual(
      labels(asGroup(baseless.sidebar[0]).children)
    );
  });

  it("resolves a tab with no index page to its first section page", () => {
    // `/examples` has no index page, so linking straight to it would 404. The
    // tab should resolve to the first page shown in the section (sidebar order).
    const folderMeta = new Map<string, FolderMeta>([
      ["examples", { order: 0, pages: ["hello-world", "goodbye"] }],
    ]);
    const nav = buildNavigation(
      [
        page("examples/goodbye.mdx", "/examples/goodbye", "Goodbye"),
        page(
          "examples/hello-world.mdx",
          "/examples/hello-world",
          "Hello World"
        ),
      ],
      { folderMeta, tabs: [{ label: "Examples", path: "/examples" }] }
    );
    const firstPage = asPage(asGroup(nav.sidebar[0]).children[0]);
    expect(firstPage.route).toBe("/examples/hello-world");
    expect(nav.tabs[0]?.href).toBe("/examples/hello-world");
  });

  it("leaves a tab's href unset when its section has an index page", () => {
    const nav = buildNavigation(
      [
        page("docs/index.mdx", "/docs", "Overview"),
        page("docs/usage.mdx", "/docs/usage", "Usage"),
      ],
      { folderMeta: empty, tabs: [{ label: "Docs", path: "/docs" }] }
    );
    expect(nav.tabs[0]?.href).toBeUndefined();
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

  it("orders changelog entries newest-first by publish date", () => {
    // Dates deliberately disagree with label order to prove the sort keys on
    // the publish date, not the version string.
    const nav = buildNavigation(
      [
        changelogPage("v6-0-0", "app@6.0.0", "2024-01-01"),
        changelogPage("v5-6-4", "app@5.6.4", "2024-03-01"),
        changelogPage("v5-6-0", "app@5.6.0", "2024-05-01"),
      ],
      { folderMeta: empty }
    );

    const group = asGroup(nav.sidebar[0]);
    expect(labels(group.children)).toStrictEqual([
      "app@5.6.0",
      "app@5.6.4",
      "app@6.0.0",
    ]);
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

  it("treats a numeric-prefixed index (01-index) as the folder index", () => {
    // Route mapping strips the ordering prefix before dropping `index`, so
    // `01-index.mdx` routes to the folder — it must sort first (like `index`)
    // and keep the group's route path, not shift it by a phantom page segment.
    const nav = buildNavigation(
      [
        // Inserted first so the group's routePath comes from the index page.
        page("guides/01-index.mdx", "/guides", "Guide Home"),
        page("guides/02-setup.mdx", "/guides/setup", "Setup"),
      ],
      { folderMeta: empty }
    );
    const group = asGroup(nav.sidebar[0]);
    expect(group.path).toBe("/guides");
    expect(labels(group.children)).toStrictEqual(["Guide Home", "Setup"]);
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

describe("buildNavigation — index title / folder meta title diagnostics", () => {
  it("warns when an index page's title diverges from its folder's meta.title", () => {
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { title: "Guides" }],
    ]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation([page("guide/index.md", "/guide", "Guide Home")], {
      diagnostics,
      folderMeta,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_NAV_INDEX_TITLE_MISMATCH");
    expect(diagnostics[0]?.message).toContain('"Guide Home"');
    expect(diagnostics[0]?.message).toContain('"Guides"');
  });

  it("does not warn when the index page's title already matches", () => {
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { title: "Guides" }],
    ]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation([page("guide/index.md", "/guide", "Guides")], {
      diagnostics,
      folderMeta,
    });
    expect(diagnostics).toHaveLength(0);
  });

  it("does not warn when the folder has no explicit meta.title", () => {
    const diagnostics: Diagnostic[] = [];
    buildNavigation([page("guide/index.md", "/guide", "Guide Home")], {
      diagnostics,
      folderMeta: empty,
    });
    expect(diagnostics).toHaveLength(0);
  });

  it("does not warn about a non-index page's title diverging from the group", () => {
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { title: "Guides" }],
    ]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation([page("guide/setup.md", "/guide/setup", "Setup")], {
      diagnostics,
      folderMeta,
    });
    expect(diagnostics).toHaveLength(0);
  });

  it("does not warn when the index page has no explicit frontmatter title", () => {
    // No frontmatter `title` — `title` here simulates a derived value (from an
    // H1 or the filename), which almost never coincidentally matches a custom
    // folder title. Flagging that would be noise on exactly the plain-landing
    // -page case least worth warning about.
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { title: "Guides" }],
    ]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        {
          contentType: "doc",
          format: "mdx",
          groups: [],
          headings: [],
          id: "guide/index.md",
          links: [],
          locale: "",
          meta: pageMetaSchema.parse({}),
          navPath: "guide/index.md",
          route: "/guide",
          segments: [],
          source: { name: "filesystem", ref: "guide/index.md" },
          sourcePath: "/abs/guide/index.md",
          title: "Index",
          translationKey: "/guide",
        },
      ],
      { diagnostics, folderMeta }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("does not warn about the root group's meta.title (never rendered as a label)", () => {
    const folderMeta = new Map<string, FolderMeta>([["", { title: "Home" }]]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation([page("index.md", "/", "Welcome")], {
      diagnostics,
      folderMeta,
    });
    expect(diagnostics).toHaveLength(0);
  });

  it("warns for a sidebar-hidden index page, which still renders its own <title>", () => {
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { title: "Guides" }],
    ]);
    const diagnostics: Diagnostic[] = [];
    const nav = buildNavigation(
      [page("guide/index.md", "/guide", "Guide Home", { hidden: true })],
      { diagnostics, folderMeta }
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_NAV_INDEX_TITLE_MISMATCH");
    // Hidden means hidden: the diagnostic must not leak the page into the tree.
    expect(nav.sidebar).toHaveLength(0);
  });

  it("does not warn about a fallback-filled index page (its title belongs to another locale)", () => {
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { title: "Guides" }],
    ]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [{ ...page("guide/index.md", "/guide", "Guide Home"), fallback: true }],
      { diagnostics, folderMeta }
    );
    expect(diagnostics).toHaveLength(0);
  });
});

describe("buildNavigation — duplicate sidebar order diagnostics", () => {
  it("warns when two pages share an explicit sidebar.order", () => {
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        page("guide/alpha.md", "/guide/alpha", "Alpha", { order: 1 }),
        page("guide/beta.md", "/guide/beta", "Beta", { order: 1 }),
      ],
      { diagnostics, folderMeta: empty }
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_DUPLICATE_SIDEBAR_ORDER");
    expect(diagnostics[0]?.message).toContain('"Alpha"');
    expect(diagnostics[0]?.message).toContain('"Beta"');
    // Anchored to the first tied page's source file.
    expect(diagnostics[0]?.file).toBe("/abs/guide/alpha.md");
  });

  it("lists a three-way tie with commas", () => {
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        page("guide/a.md", "/guide/a", "A", { order: 2 }),
        page("guide/b.md", "/guide/b", "B", { order: 2 }),
        page("guide/c.md", "/guide/c", "C", { order: 2 }),
      ],
      { diagnostics, folderMeta: empty }
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('"A", "B", and "C" all have');
  });

  it("warns when two folders share a folder-meta order", () => {
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { order: 4 }],
      ["reference", { order: 4 }],
    ]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        page("guide/setup.md", "/guide/setup", "Setup"),
        page("reference/api.md", "/reference/api", "Api"),
      ],
      { diagnostics, folderMeta }
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_DUPLICATE_SIDEBAR_ORDER");
    // A folder-only tie has no single source file to anchor to.
    expect(diagnostics[0]?.file).toBeUndefined();
  });

  it("does not warn when both sides fall back to the default order", () => {
    // Neither page has a numeric prefix or explicit order — both land on the
    // same fallback order and sort alphabetically, which is intentional.
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        page("guide/alpha.md", "/guide/alpha", "Alpha"),
        page("guide/beta.md", "/guide/beta", "Beta"),
      ],
      { diagnostics, folderMeta: empty }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("does not throw when no diagnostics sink is passed", () => {
    expect(() =>
      buildNavigation(
        [
          page("guide/alpha.md", "/guide/alpha", "Alpha", { order: 1 }),
          page("guide/beta.md", "/guide/beta", "Beta", { order: 1 }),
        ],
        { folderMeta: empty }
      )
    ).not.toThrow();
  });

  it("does not warn when two changelog entries share a publish date", () => {
    // The order is derived from the date, not chosen by the author, so a
    // same-day release pair isn't a duplicate-order authoring mistake.
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        changelogPage("app-1", "app@1.0.1", "2024-01-01"),
        changelogPage("app-2", "app@1.0.2", "2024-01-01"),
      ],
      { diagnostics, folderMeta: empty }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("does not warn for undated changelog entries with date-prefixed filenames", () => {
    // With no date, the order falls back to the numeric filename prefix — a
    // date stamp (`2024-...`), not an authored rank, so the tie isn't flagged.
    const undated = (ref: string, title: string): PageRecord => ({
      ...changelogPage(ref, title, "2024-01-01"),
      meta: pageMetaSchema.parse({ type: "changelog" }),
    });
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        undated("2024-01-05-first", "app@1.0.0"),
        undated("2024-01-09-second", "app@1.1.0"),
      ],
      { diagnostics, folderMeta: empty }
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("warns when a folder-meta pages[] rank collides with an explicit sidebar.order", () => {
    // "alpha" gets rank 0 from meta.pages; "beta" separately claims order 0
    // via its own frontmatter. Both are authored, so the tie is real.
    const folderMeta = new Map<string, FolderMeta>([
      ["guide", { pages: ["alpha"] }],
    ]);
    const diagnostics: Diagnostic[] = [];
    buildNavigation(
      [
        page("guide/alpha.md", "/guide/alpha", "Alpha"),
        page("guide/beta.md", "/guide/beta", "Beta", { order: 0 }),
      ],
      { diagnostics, folderMeta }
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_DUPLICATE_SIDEBAR_ORDER");
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

describe("buildNavigation — basePath", () => {
  // Content routes arrive already based (from normalize); config paths are
  // authored as if mounted at root and are based here.
  const pages = [page("foo.md", "/docs/foo", "Foo")];

  it("bases config tabs, featured, and selector paths, leaving externals", () => {
    const nav = buildNavigation(pages, {
      basePath: "/docs",
      featured: [
        { href: "/changelog", label: "Changelog" },
        { href: "https://x.com", label: "External" },
      ],
      folderMeta: empty,
      selectors: [
        { items: [{ label: "v1", path: "/v1" }], kind: "version", label: "v2" },
      ],
      tabs: [
        {
          items: [{ label: "Guide", path: "/guide" }],
          label: "Docs",
          path: "/",
        },
        { label: "Blog", path: "https://blog.example.com" },
      ],
    });

    expect(nav.featured.map((link) => link.href)).toStrictEqual([
      "/docs/changelog",
      "https://x.com",
    ]);
    expect(nav.selectors[0]?.items?.[0]?.path).toBe("/docs/v1");
    expect(nav.tabs[0]?.path).toBe("/docs");
    expect(nav.tabs[0]?.items?.[0]?.path).toBe("/docs/guide");
    expect(nav.tabs[1]?.path).toBe("https://blog.example.com");
  });

  it("bases explicit-sidebar refs, hrefs, and unmatched fallbacks", () => {
    const sidebar: SidebarItemConfig[] = [
      // A base-less string ref still resolves to the based page route.
      "foo",
      { href: "/external-page", label: "Ext" },
      { items: [], label: "Missing", root: "/nope" },
    ];
    const nav = buildNavigation(pages, {
      basePath: "/docs",
      folderMeta: empty,
      sidebar,
    });

    expect(asPage(nav.sidebar[0]).route).toBe("/docs/foo");
    expect(asPage(nav.sidebar[1]).route).toBe("/docs/external-page");
    // An unmatched group `root` falls back to the based ref.
    expect(asGroup(nav.sidebar[2]).route).toBe("/docs/nope");
  });
});
