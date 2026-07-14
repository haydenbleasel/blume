import { describe, expect, it } from "bun:test";

import {
  activeTabForRoute,
  sidebarForRoute,
} from "../src/components/layout/nav-utils.ts";
import type { NavNode, NavTab } from "../src/core/types.ts";

const page = (label: string, route: string): NavNode => ({
  kind: "page",
  label,
  pageId: label,
  route,
});

const group = (label: string, path: string, children: NavNode[]): NavNode => ({
  children,
  kind: "group",
  label,
  path,
});

// A multi-section site: one group per section, each at its own URL path.
const TREE: NavNode[] = [
  group("Adapters", "/adapters", [
    page("S3", "/adapters/s3"),
    page("GCS", "/adapters/gcs"),
  ]),
  group("API", "/api", [page("Files", "/api/files")]),
];

const TABS: NavTab[] = [
  { label: "Adapters", path: "/adapters" },
  { label: "API", path: "/api" },
];

const labels = (nodes: NavNode[]): string[] => nodes.map((node) => node.label);

describe("activeTabForRoute", () => {
  it("uses the root tab as a fallback for child routes", () => {
    const documentation: NavTab = { label: "Documentation", path: "/" };
    const examples: NavTab = { label: "Examples", path: "/examples" };
    const tabs = [documentation, examples];

    expect(activeTabForRoute(tabs, "/guides/services")).toBe(documentation);
  });

  it("prefers the longest matching tab path", () => {
    const documentation: NavTab = { label: "Documentation", path: "/" };
    const examples: NavTab = { label: "Examples", path: "/examples" };
    const tabs = [documentation, examples];

    expect(activeTabForRoute(tabs, "/examples/hello-world")).toBe(examples);
  });

  it("returns null when no tab matches", () => {
    expect(activeTabForRoute(TABS, "/changelog")).toBeNull();
  });
});

describe("sidebarForRoute", () => {
  it("scopes to the active tab's section group", () => {
    expect(labels(sidebarForRoute(TREE, TABS, "/adapters/s3"))).toStrictEqual([
      "S3",
      "GCS",
    ]);
    expect(labels(sidebarForRoute(TREE, TABS, "/api/files"))).toStrictEqual([
      "Files",
    ]);
  });

  it("resolves the section even when wrapped in a container group", () => {
    // Content mapped under a /docs prefix nests every section beneath a single
    // top-level "Docs" group — the tab must still resolve to its own section.
    const wrapped: NavNode[] = [
      group("Docs", "/docs", [
        group("Adapters", "/docs/adapters", [page("S3", "/docs/adapters/s3")]),
        group("API", "/docs/api", [page("Files", "/docs/api/files")]),
      ]),
    ];
    const tabs: NavTab[] = [{ label: "Adapters", path: "/docs/adapters" }];
    expect(
      labels(sidebarForRoute(wrapped, tabs, "/docs/adapters/s3"))
    ).toStrictEqual(["S3"]);
  });

  it("preserves sub-groups inside the section (does not over-unwrap)", () => {
    const tree: NavNode[] = [
      group("Guides", "/docs/guides", [
        group("Getting started", "/docs/guides/start", [
          page("Intro", "/docs/guides/start/intro"),
        ]),
      ]),
    ];
    const tabs: NavTab[] = [{ label: "Guides", path: "/docs/guides" }];
    expect(
      labels(sidebarForRoute(tree, tabs, "/docs/guides/start/intro"))
    ).toStrictEqual(["Getting started"]);
  });

  it("picks the longest-prefix tab when sections nest", () => {
    const tree: NavNode[] = [
      group("Docs", "/docs", [
        group("API", "/docs/api", [page("Endpoints", "/docs/api/endpoints")]),
      ]),
    ];
    const tabs: NavTab[] = [
      { label: "Docs", path: "/docs" },
      { label: "API", path: "/docs/api" },
    ];
    expect(
      labels(sidebarForRoute(tree, tabs, "/docs/api/endpoints"))
    ).toStrictEqual(["Endpoints"]);
  });

  it("returns the full sidebar when no tabs are configured", () => {
    expect(labels(sidebarForRoute(TREE, [], "/adapters/s3"))).toStrictEqual([
      "Adapters",
      "API",
    ]);
  });

  it("hides tab-owned groups on a route under no tab, keeping loose content", () => {
    // Root-level pages and a non-tab group ("Help") alongside the section
    // groups. On a non-scoped route the sections (which already have header
    // tabs) drop out; the loose pages and the non-tab group stay.
    const tree: NavNode[] = [
      page("Overview", "/"),
      page("Changelog", "/changelog"),
      group("Help", "/help", [page("FAQ", "/help/faq")]),
      ...TREE,
    ];
    expect(labels(sidebarForRoute(tree, TABS, "/changelog"))).toStrictEqual([
      "Overview",
      "Changelog",
      "Help",
    ]);
  });

  it("hides tab-owned groups for the root tab, keeping loose pages", () => {
    const tabs: NavTab[] = [{ label: "Home", path: "/" }, ...TABS];
    const tree: NavNode[] = [page("Overview", "/"), ...TREE];
    expect(labels(sidebarForRoute(tree, tabs, "/"))).toStrictEqual([
      "Overview",
    ]);
  });

  it("hides a config-style tab section matched by its group route", () => {
    // Config-built groups carry a link `route` instead of a `path`.
    const tree: NavNode[] = [
      page("Home", "/"),
      {
        children: [page("Files", "/api/files")],
        kind: "group",
        label: "API",
        route: "/api",
      },
    ];
    const tabs: NavTab[] = [{ label: "API", path: "/api" }];
    expect(labels(sidebarForRoute(tree, tabs, "/"))).toStrictEqual(["Home"]);
  });

  it("drops a container left empty once its sections become tabs", () => {
    // A container that only holds tab sections, next to a loose page. On the
    // root route the sections drop out and the emptied "Reference" heading is
    // dropped too, so it is not stranded above the surviving page.
    const tree: NavNode[] = [
      page("Home", "/"),
      group("Reference", "/reference", [
        group("Adapters", "/reference/adapters", [
          page("S3", "/reference/adapters/s3"),
        ]),
        group("API", "/reference/api", [page("Files", "/reference/api/files")]),
      ]),
    ];
    const tabs: NavTab[] = [
      { label: "Adapters", path: "/reference/adapters" },
      { label: "API", path: "/reference/api" },
    ];
    expect(labels(sidebarForRoute(tree, tabs, "/"))).toStrictEqual(["Home"]);
  });

  it("falls back to the full sidebar when every group is a tab (never blanks)", () => {
    // No loose pages: hiding the sections would blank the sidebar, so the full
    // tree is shown instead.
    const tabs: NavTab[] = [{ label: "Home", path: "/" }, ...TABS];
    expect(labels(sidebarForRoute(TREE, tabs, "/"))).toStrictEqual([
      "Adapters",
      "API",
    ]);
  });

  it("shows an empty sidebar when the matched tab owns no group", () => {
    const tabs: NavTab[] = [{ label: "AI", path: "/ai" }];
    // The route matches the tab, but no group sits at /ai — the section has no
    // sidebar pages, so show nothing rather than leak the other tabs' groups.
    expect(labels(sidebarForRoute(TREE, tabs, "/ai/embed"))).toStrictEqual([]);
  });

  it("does not leak other tabs' sections onto a group-less changelog tab", () => {
    // The changelog is a generated route with its own header tab but no sidebar
    // group (its entries render as a timeline, not sidebar pages). It must not
    // fall through to the full tree — that showed the OpenAPI "API" section.
    const tabs: NavTab[] = [
      ...TABS,
      { label: "Changelog", path: "/changelog" },
    ];
    expect(labels(sidebarForRoute(TREE, tabs, "/changelog"))).toStrictEqual([]);
  });

  it("does not treat a sibling prefix as the section (/adapters vs /adapters-x)", () => {
    const tree: NavNode[] = [
      group("Adapters", "/adapters", [page("S3", "/adapters/s3")]),
      group("AdaptersX", "/adapters-x", [page("Extra", "/adapters-x/extra")]),
    ];
    const tabs: NavTab[] = [{ label: "A", path: "/adapters" }];
    expect(labels(sidebarForRoute(tree, tabs, "/adapters/s3"))).toStrictEqual([
      "S3",
    ]);
  });
});
