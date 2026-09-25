import { describe, expect, it } from "bun:test";

import { buildNavigation } from "../src/core/navigation.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";
import type {
  NormalizeContext,
  SourceEntry,
} from "../src/core/sources/types.ts";
import type { NavNode, PageRecord } from "../src/core/types.ts";

const CTX: NormalizeContext = {
  defaultType: "doc",
  source: { name: "s", staged: false },
};

const normalize = (ref: string, data: SourceEntry["data"] = {}) =>
  normalizeEntry({ body: { format: "md", text: "Body.\n" }, data, ref }, CTX);

const pageOf = (ref: string, data: SourceEntry["data"] = {}): PageRecord => {
  const [page] = normalize(ref, data).pages;
  if (!page) {
    throw new Error(`expected a page for ${ref}`);
  }
  return page;
};

const labels = (nodes: NavNode[]): string[] => nodes.map((node) => node.label);

describe("URL syntax in file names", () => {
  it("drops #, ?, and % from routes so links reach the written page", () => {
    // Unescaped, `/sdks/c#` lands on `/sdks/c` while Astro writes `c%23/`,
    // and a bare `%` is an invalid URL.
    expect(pageOf("sdks/c#.md").route).toBe("/sdks/c");
    expect(pageOf("sdks/why?.md").route).toBe("/sdks/why");
    expect(pageOf("sdks/100%.md").route).toBe("/sdks/100");
    expect(pageOf("x.md", { slug: "sdks/f#" }).route).toBe("/sdks/f");
  });
});

describe("dot segments in a frontmatter slug", () => {
  it("rejects the page with a diagnostic at the slug", () => {
    for (const slug of ["../../../etc/escape", "guides/./x", ".", "a/.."]) {
      const { diagnostics, pages } = normalize("x.md", { slug });
      expect(pages).toStrictEqual([]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "BLUME_FRONTMATTER_INVALID",
        schemaPath: "slug",
        severity: "error",
      });
      expect(diagnostics[0]?.message).toContain('"." or ".." segment');
    }
  });

  it("points at the slug line in the source", () => {
    const raw = "---\ntitle: X\nslug: ../escape\n---\nBody.\n";
    const { diagnostics } = normalizeEntry(
      {
        body: { format: "md", text: "Body.\n" },
        data: { slug: "../escape", title: "X" },
        raw,
        ref: "x.md",
      },
      CTX
    );
    expect(diagnostics[0]?.line).toBe(3);
  });

  it("keeps names that merely contain dots", () => {
    expect(pageOf("x.md", { slug: "v1.2/.well-known/..x" }).route).toBe(
      "/v1.2/.well-known/..x"
    );
  });
});

describe("ordering prefixes on group folders", () => {
  it("routes a prefix outside the parentheses like a group", () => {
    expect(pageOf("02-(gamma)/g.md").route).toBe("/g");
    expect(pageOf("02-(gamma)/g.md").groups).toStrictEqual(["gamma"]);
    // An untitled index takes its group's label, prefix and parentheses gone.
    expect(pageOf("02-(gamma)/index.md").title).toBe("Gamma");
    expect(pageOf("(01-zeta)/index.md").title).toBe("Zeta");
  });

  it("sorts a prefixed group like any prefixed folder", () => {
    const pages = [
      "(beta)/b.md",
      "03-alpha/c.md",
      "02-(gamma)/g.md",
      "(01-zeta)/a.md",
    ].map((ref) => pageOf(ref));
    const nav = buildNavigation(pages, { folderMeta: new Map() });
    expect(labels(nav.sidebar)).toStrictEqual([
      "Zeta",
      "Gamma",
      "Alpha",
      "Beta",
    ]);
    expect(pages.map((page) => page.route)).toStrictEqual([
      "/b",
      "/alpha/c",
      "/g",
      "/a",
    ]);
  });

  it("ranks a prefixed group by its bare name in meta pages", () => {
    const pages = ["02-(gamma)/g.md", "(01-zeta)/a.md"].map((ref) =>
      pageOf(ref)
    );
    const nav = buildNavigation(pages, {
      folderMeta: new Map([["", { pages: ["gamma", "zeta"] }]]),
    });
    expect(labels(nav.sidebar)).toStrictEqual(["Gamma", "Zeta"]);
  });
});
