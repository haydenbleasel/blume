import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildLlmsFiles } from "../src/ai/llms.ts";
import { prefixBase, withBase } from "../src/components/islands/base-path.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { buildRssFeeds, renderRssFeed } from "../src/deploy/rss.ts";
import { buildSitemap } from "../src/deploy/sitemap.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";

// ---------------------------------------------------------------------------
// Render helper (`prefixBase` / `withBase`)
// ---------------------------------------------------------------------------

describe("prefixBase", () => {
  it("prefixes root-relative routes, idempotently", () => {
    expect(prefixBase("/sub", "/guide")).toBe("/sub/guide");
    expect(prefixBase("/sub", "/")).toBe("/sub");
    expect(prefixBase("/sub", "/sub/guide")).toBe("/sub/guide");
    // A trailing slash on BASE_URL (Astro's `trailingSlash: "ignore"`) is fine.
    expect(prefixBase("/sub/", "/guide")).toBe("/sub/guide");
  });

  it("is a no-op for a root base and passes non-internal targets through", () => {
    expect(prefixBase("/", "/guide")).toBe("/guide");
    expect(prefixBase("/sub", "https://x.com")).toBe("https://x.com");
    expect(prefixBase("/sub", "//host")).toBe("//host");
    expect(prefixBase("/sub", "#anchor")).toBe("#anchor");
  });

  it("binds withBase to BASE_URL (unset in tests -> pass-through)", () => {
    // `import.meta.env.BASE_URL` is undefined under the test runner, so this
    // resolves to a `/` base and returns the route unchanged.
    expect(withBase("/guide")).toBe("/guide");
  });
});

// ---------------------------------------------------------------------------
// JSON-LD carries the deployment base
// ---------------------------------------------------------------------------

describe("buildStructuredData under deployment.base", () => {
  it("prefixes page + breadcrumb URLs and the website node", () => {
    const data = buildStructuredData({
      base: "/sub",
      breadcrumbs: [
        { label: "Home", route: "/" },
        { label: "Guides", route: "/guides" },
        { label: "Intro", route: "/guides/intro" },
      ],
      description: "d",
      route: "/guides/intro",
      siteName: "Docs",
      siteUrl: "https://example.com",
      title: "Intro",
    });
    const graph = (data?.["@graph"] ?? []) as Record<string, unknown>[];
    const site = graph.find((n) => n["@type"] === "WebSite");
    const page = graph.find((n) => n["@type"] === "TechArticle");
    const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList");
    expect(site?.url).toBe("https://example.com/sub");
    expect(page?.url).toBe("https://example.com/sub/guides/intro");
    const items = (crumbs?.itemListElement ?? []) as Record<string, unknown>[];
    expect(items[1]?.item).toBe("https://example.com/sub/guides");
  });
});

// ---------------------------------------------------------------------------
// Node-side SEO files carry the deployment base (full pipeline)
// ---------------------------------------------------------------------------

const dirs: string[] = [];

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-deploybase-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const FIXTURE: Record<string, string> = {
  "blume.config.ts":
    'export default { deployment: { base: "/sub", site: "https://example.com" }, seo: { rss: { types: ["blog"] } } };\n',
  "docs/blog/hello.md": "---\ndate: 2026-01-01\ntype: blog\n---\n# Hello\n",
  "docs/getting-started.md": "# Getting started\n",
  "docs/index.md": "# Home\n",
};

describe("SEO files under deployment.base", () => {
  it("carries the base through sitemap, llms.txt, and RSS", async () => {
    const project = await scanProject(await makeProject(FIXTURE), {
      mode: "build",
    });

    const sitemap = buildSitemap(project);
    expect(sitemap).toContain("https://example.com/sub/getting-started");

    const { index, full } = await buildLlmsFiles(project);
    expect(index).toContain("https://example.com/sub/getting-started");
    expect(full).toContain("https://example.com/sub/getting-started");

    const [feed] = buildRssFeeds(project);
    if (!feed) {
      throw new Error("expected a blog RSS feed");
    }
    const xml = renderRssFeed(feed);
    expect(xml).toContain("https://example.com/sub/blog/hello");
    // The feed's self link sits under the base; its on-disk path stays base-less.
    expect(xml).toContain("https://example.com/sub/blog/rss.xml");
    expect(feed.path).toBe("/blog/rss.xml");
  });
});
