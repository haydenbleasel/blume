import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { dirname, join } from "pathe";

import { buildLlmsFiles } from "../src/ai/llms.ts";
import {
  deployBase,
  prefixBase,
  withBase,
  withMountedBase,
} from "../src/components/islands/base-path.ts";
import { DEPLOY_BASE_DEFINE } from "../src/core/base-path.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { buildRssFeeds, renderRssFeed } from "../src/deploy/rss.ts";
import { buildSitemapFiles } from "../src/deploy/sitemap.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import type { JsonLdNode } from "../src/seo/jsonld.ts";

// ---------------------------------------------------------------------------
// Render helper (`prefixBase` / `withBase`)
// ---------------------------------------------------------------------------

describe("prefixBase", () => {
  it("prefixes root-relative routes, idempotently", () => {
    expect(prefixBase("/sub", "/guide")).toBe("/sub/guide");
    expect(prefixBase("/sub", "/")).toBe("/sub");
    expect(prefixBase("/sub", "/sub/guide")).toBe("/sub/guide");
    // A trailing slash on BASE_URL (an owned config's `trailingSlash`) is fine.
    expect(prefixBase("/sub/", "/guide")).toBe("/sub/guide");
  });

  it("is a no-op for a root base and passes non-internal targets through", () => {
    expect(prefixBase("/", "/guide")).toBe("/guide");
    expect(prefixBase("/sub", "https://x.com")).toBe("https://x.com");
    expect(prefixBase("/sub", "//host")).toBe("//host");
    expect(prefixBase("/sub", "#anchor")).toBe("#anchor");
  });

  it("binds withBase to the deployment base (root in tests -> pass-through)", () => {
    // Nothing defines a base under the test runner, so this resolves to a
    // `/` base and returns the route unchanged.
    expect(withBase("/guide")).toBe("/guide");
  });
});

// ---------------------------------------------------------------------------
// Where the base is read from (`deployBase`)
// ---------------------------------------------------------------------------

/** Put an environment variable back the way a test found it. */
const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
};

describe("deployBase", () => {
  // Bun aliases `import.meta.env` to `process.env`, so the environment stands
  // in for the constants a build inlines. Other suites leave `BASE_URL` set.
  const { BASE_URL, BLUME_BASE_URL } = process.env;

  afterEach(() => {
    restoreEnv("BASE_URL", BASE_URL);
    restoreEnv("BLUME_BASE_URL", BLUME_BASE_URL);
  });

  it("reads Blume's own constant, whatever Astro's field holds", () => {
    // A server build inlines the environment's `BASE_URL` over Astro's field.
    process.env.BASE_URL = "https://api.example.com";
    process.env.BLUME_BASE_URL = "/docs";
    expect(deployBase()).toBe("/docs");
    expect(withBase("/guide")).toBe("/docs/guide");
    expect(withMountedBase("/guide")).toBe("/docs/guide");
  });

  it("falls back to Astro's field, then to the root", () => {
    Reflect.deleteProperty(process.env, "BLUME_BASE_URL");
    process.env.BASE_URL = "/sub";
    expect(deployBase()).toBe("/sub");
    Reflect.deleteProperty(process.env, "BASE_URL");
    expect(deployBase()).toBe("/");
  });

  it("is the only place the site's code reads the base", async () => {
    // A real path, not `URL.pathname` (percent-encoding, Windows drive paths).
    const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
    const accessor = "components/islands/base-path.ts";
    const direct: string[] = [];
    for await (const found of new Bun.Glob("**/*.{astro,ts,tsx}").scan(
      srcRoot
    )) {
      const file = found.replaceAll("\\", "/");
      const source = await readFile(join(srcRoot, file), "utf-8");
      if (file !== accessor && source.includes("import.meta.env.BASE_URL")) {
        direct.push(file);
      }
    }
    expect(direct).toStrictEqual([]);
    // And it reads the constant the integration defines.
    expect(await readFile(join(srcRoot, accessor), "utf-8")).toContain(
      `${DEPLOY_BASE_DEFINE} ??`
    );
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
    // SAFETY: buildStructuredData always emits `@graph` as the node array.
    const graph = (data?.["@graph"] ?? []) as JsonLdNode[];
    const site = graph.find((n) => n["@type"] === "WebSite");
    const page = graph.find((n) => n["@type"] === "TechArticle");
    const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList");
    expect(site?.url).toBe("https://example.com/sub");
    expect(page?.url).toBe("https://example.com/sub/guides/intro");
    // SAFETY: the BreadcrumbList node's `itemListElement` is always a ListItem array.
    const items = (crumbs?.itemListElement ?? []) as JsonLdNode[];
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

const FIXTURE = {
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

    const sitemap = buildSitemapFiles(project)?.[0]?.xml ?? "";
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
