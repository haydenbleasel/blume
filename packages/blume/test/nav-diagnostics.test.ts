import { describe, expect, it } from "bun:test";

import {
  validateNavIcons,
  validateNavStructure,
  validateNavTargets,
  validateSearchPopularIcons,
} from "../src/core/nav-diagnostics.ts";
import type { Navigation, PageRecord } from "../src/core/types.ts";

const nav = (over: Partial<Navigation> = {}): Navigation => ({
  featured: [],
  selectors: [],
  sidebar: [],
  tabs: [],
  ...over,
});

describe("validateSearchPopularIcons", () => {
  it("warns about an unknown icon name, naming the link", () => {
    const result = validateSearchPopularIcons([
      { icon: "not-a-real-icon", label: "Start" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("BLUME_UNKNOWN_ICON");
    expect(result[0]?.message).toContain("not-a-real-icon");
    expect(result[0]?.message).toContain('popular link "Start"');
  });

  it("accepts a known built-in icon and an entry with none", () => {
    expect(
      validateSearchPopularIcons([
        { icon: "rocket", label: "Start" },
        { label: "No icon" },
      ])
    ).toEqual([]);
  });
});

describe("validateNavIcons", () => {
  it("warns about an unknown icon name", () => {
    const result = validateNavIcons(
      nav({ tabs: [{ icon: "not-a-real-icon", label: "Home", path: "/" }] })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("BLUME_UNKNOWN_ICON");
    expect(result[0]?.message).toContain("not-a-real-icon");
  });

  it("accepts a known built-in icon", () => {
    expect(
      validateNavIcons(
        nav({ tabs: [{ icon: "book-open", label: "Docs", path: "/docs" }] })
      )
    ).toEqual([]);
  });

  it("skips image and inline-SVG icons", () => {
    const result = validateNavIcons(
      nav({
        sidebar: [
          {
            icon: "/logo.svg",
            kind: "page",
            label: "A",
            pageId: "a",
            route: "/a",
          },
          {
            icon: "<svg></svg>",
            kind: "page",
            label: "B",
            pageId: "b",
            route: "/b",
          },
          {
            icon: "https://x.dev/i.png",
            kind: "page",
            label: "C",
            pageId: "c",
            route: "/c",
          },
        ],
      })
    );
    expect(result).toEqual([]);
  });

  it("collects icons from tab items and selectors", () => {
    const result = validateNavIcons(
      nav({
        selectors: [
          {
            items: [{ icon: "bad-selector-icon", label: "V1", path: "/v1" }],
            kind: "version",
            label: "Version",
          },
        ],
        tabs: [
          {
            items: [{ icon: "bad-tab-item-icon", label: "Sub", path: "/sub" }],
            label: "Home",
            path: "/",
          },
        ],
      })
    );
    const messages = result.map((d) => d.message).join(" ");
    expect(messages).toContain("bad-tab-item-icon");
    expect(messages).toContain("bad-selector-icon");
  });

  it("collects icons from featured links", () => {
    const result = validateNavIcons(
      nav({
        featured: [{ href: "/blog", icon: "bad-featured-icon", label: "Blog" }],
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain("bad-featured-icon");
    expect(result[0]?.message).toContain('featured link "Blog"');
  });

  it("recurses into groups and dedupes repeated unknown icons", () => {
    const result = validateNavIcons(
      nav({
        sidebar: [
          {
            children: [
              {
                icon: "bogus",
                kind: "page",
                label: "A",
                pageId: "a",
                route: "/a",
              },
              {
                icon: "bogus",
                kind: "page",
                label: "B",
                pageId: "b",
                route: "/b",
              },
            ],
            icon: "bogus",
            kind: "group",
            label: "Group",
          },
        ],
      })
    );
    expect(result).toHaveLength(1);
  });
});

const page = (id: string, hidden: boolean): PageRecord =>
  ({ id, meta: { sidebar: { hidden } } }) as unknown as PageRecord;

describe("validateNavTargets", () => {
  it("warns when a tab points at a route with no pages", () => {
    const result = validateNavTargets(
      nav({ tabs: [{ label: "Guides", path: "/guides" }] }),
      new Set(["/docs", "/docs/intro"])
    );
    expect(result.map((d) => d.code)).toContain("BLUME_NAV_MISSING_PAGE");
  });

  it("accepts a tab that matches a section prefix", () => {
    const result = validateNavTargets(
      nav({ tabs: [{ label: "Docs", path: "/docs" }] }),
      new Set(["/docs/intro"])
    );
    expect(result).toEqual([]);
  });

  it("accepts a tab served by a custom page route", () => {
    const result = validateNavTargets(
      nav({ tabs: [{ label: "Home", path: "/" }] }),
      new Set(["/", "/docs/intro"])
    );
    expect(result).toEqual([]);
  });

  it("warns when a selector item points at a route with no pages", () => {
    const result = validateNavTargets(
      nav({
        selectors: [
          {
            items: [{ label: "V2", path: "/v2" }],
            kind: "version",
            label: "Version",
          },
        ],
      }),
      new Set(["/v1"])
    );
    expect(result.map((d) => d.code)).toContain("BLUME_NAV_MISSING_PAGE");
  });

  it("ignores external tab paths", () => {
    const result = validateNavTargets(
      nav({ tabs: [{ label: "Blog", path: "https://x.dev/blog" }] }),
      new Set()
    );
    expect(result).toEqual([]);
  });

  it("warns on an internal featured link with no page but ignores external ones", () => {
    const result = validateNavTargets(
      nav({
        featured: [
          { href: "https://x.dev/blog", label: "Blog" },
          { href: "/missing", label: "Missing" },
        ],
      }),
      new Set(["/docs"])
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain("/missing");
  });
});

describe("validateNavStructure", () => {
  it("warns on duplicate labels at the same level", () => {
    const result = validateNavStructure(
      nav({
        sidebar: [
          { kind: "page", label: "Intro", pageId: "a", route: "/a" },
          { kind: "page", label: "Intro", pageId: "b", route: "/b" },
        ],
      }),
      []
    );
    expect(result.map((d) => d.code)).toContain("BLUME_NAV_DUPLICATE_LABEL");
  });

  it("warns when a hidden page appears in the sidebar", () => {
    const result = validateNavStructure(
      nav({
        sidebar: [{ kind: "page", label: "Secret", pageId: "s", route: "/s" }],
      }),
      [page("s", true), page("v", false)]
    );
    expect(result.map((d) => d.code)).toContain("BLUME_NAV_HIDDEN_IN_SIDEBAR");
  });
});
