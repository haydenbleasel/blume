import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  customStaticRoutes,
  discoverPages,
  discoverPagesSync,
  hasGeneratedChangelog,
} from "../src/astro/pages.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";

let root: string;

const FILES = [
  "index.astro",
  "about.astro",
  "blog/index.astro",
  "blog/[slug].astro",
  "nested/deep/index.astro",
  // A folder literally named `index` keeps its segment (only a trailing
  // `index` file collapses to the parent).
  "index/nested.astro",
  // Astro's private-partial convention: an underscore-prefixed file or folder
  // is importable but never routed, so none of these ship as a page.
  "_FeatureBrowser.astro",
  "_home/Hero.astro",
  "blog/_draft.astro",
];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-pages-"));
  await Promise.all(
    FILES.map(async (rel) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, "<h1>page</h1>");
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("discoverPages", () => {
  it("derives route patterns, collapsing index and preserving dynamic segments", async () => {
    const routes = await discoverPages(root);
    expect(routes.map((route) => route.pattern).toSorted()).toStrictEqual([
      "/",
      "/about",
      "/blog",
      "/blog/[slug]",
      "/index/nested",
      "/nested/deep",
    ]);
  });

  it("excludes underscore-prefixed private files and folders", async () => {
    const routes = await discoverPages(root);
    const patterns = routes.map((route) => route.pattern);
    expect(patterns).not.toContain("/_FeatureBrowser");
    expect(patterns).not.toContain("/_home/Hero");
    expect(patterns).not.toContain("/blog/_draft");
  });

  it("keeps the original file as the entrypoint", async () => {
    const routes = await discoverPages(root);
    const about = routes.find((route) => route.pattern === "/about");
    expect(about?.entrypoint).toBe(join(root, "about.astro"));
  });

  it("discoverPagesSync matches the async discovery", async () => {
    expect(discoverPagesSync(root)).toStrictEqual(await discoverPages(root));
  });
});

describe("customStaticRoutes", () => {
  it("keeps static routes, skipping dynamic and private patterns", () => {
    const routes = customStaticRoutes([
      { pattern: "/" },
      { pattern: "/about" },
      { pattern: "/blog/[slug]" },
      { pattern: "/_partials/hero" },
      { pattern: "/.well-known/mcp.json" },
      // Two files can map to the same pattern set; routes are deduped.
      { pattern: "/about" },
    ]);
    expect(routes.toSorted()).toStrictEqual(["/", "/about"]);
  });
});

const projectOf = (
  pages: {
    contentType: string;
    route: string;
    meta?: Record<string, unknown>;
  }[],
  sources: { type: string }[] = []
): BlumeProject =>
  ({
    config: { content: { sources } },
    graph: {
      pages: pages.map((page) => ({
        meta: { draft: false, sidebar: { hidden: false } },
        ...page,
      })),
    },
  }) as unknown as BlumeProject;

describe("hasGeneratedChangelog", () => {
  it("is true when visible changelog entries exist", () => {
    const project = projectOf([
      { contentType: "changelog", route: "/changelog/v1" },
    ]);
    expect(hasGeneratedChangelog(project, [])).toBe(true);
  });

  it("ignores draft and hidden changelog entries", () => {
    const project = projectOf([
      {
        contentType: "changelog",
        meta: { draft: true, sidebar: { hidden: false } },
        route: "/changelog/v1",
      },
      {
        contentType: "changelog",
        meta: { draft: false, sidebar: { hidden: true } },
        route: "/changelog/v2",
      },
    ]);
    expect(hasGeneratedChangelog(project, [])).toBe(false);
  });

  it("is true for a release-backed source even with no entries", () => {
    const project = projectOf([], [{ type: "github-releases" }]);
    expect(hasGeneratedChangelog(project, [])).toBe(true);
  });

  it("is false when a custom page or content page owns /changelog", () => {
    const withEntries = projectOf([
      { contentType: "changelog", route: "/changelog/v1" },
    ]);
    expect(
      hasGeneratedChangelog(withEntries, [{ pattern: "/changelog" }])
    ).toBe(false);

    const ownedByContent = projectOf([
      { contentType: "changelog", route: "/changelog" },
    ]);
    expect(hasGeneratedChangelog(ownedByContent, [])).toBe(false);
  });
});
