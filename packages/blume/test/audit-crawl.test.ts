import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { i18nChecks } from "../src/audit/checks/i18n.ts";
import { sitemapChecks } from "../src/audit/checks/sitemap.ts";
import { crawlStaticDir, parseLlms, parseSitemap } from "../src/audit/crawl.ts";
import { pageSite } from "../src/audit/locate.ts";
import { resolveHref } from "../src/audit/url.ts";
import type { BlumeManifest, Diagnostic } from "../src/core/types.ts";
import { codes, context, snapshot } from "./audit-support.ts";

/** Reading the built site off disk, and the branches the other suites can't reach. */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const build = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-crawl-"));
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

const manifest = (routes: BlumeManifest["routes"]): BlumeManifest =>
  ({ routes }) as BlumeManifest;

const page = (title: string, body = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

const SITE = "https://x.dev";

describe("crawlStaticDir", () => {
  it("reads pages, files, the sitemap, and robots.txt in one pass", async () => {
    const dir = await build({
      "docs/api/index.html": page("API"),
      "img/logo.png": "binary",
      "index.html": page("Home"),
      "robots.txt": "User-agent: *\nDisallow: /private\n",
      "sitemap.xml": "<urlset><url><loc>https://x.dev/</loc></url></urlset>",
    });

    const result = await crawlStaticDir({
      basePath: "",
      manifest: manifest([]),
      staticDir: dir,
    });

    expect(result.pages.map((p) => p.url).toSorted()).toEqual([
      "/",
      "/docs/api",
    ]);
    expect(result.files.get("/img/logo.png")).toBe(6);
    expect(result.sitemap?.urls).toEqual(["https://x.dev/"]);
    expect(result.sitemap?.bytes).toBeGreaterThan(0);
    expect(result.robots?.disallow).toEqual(["/private"]);
  });

  it("reads llms.txt alongside the sitemap and robots.txt", async () => {
    const dir = await build({
      "index.html": page("Home"),
      "llms.txt": "# Site\n\n- [Home](https://x.dev/): The home page.\n",
    });
    const result = await crawlStaticDir({
      basePath: "",
      manifest: manifest([]),
      staticDir: dir,
    });
    expect(result.llms?.entries).toEqual([{ line: 3, url: "https://x.dev/" }]);
  });

  it("excludes <Component /> example preview frames from the audit", async () => {
    // Preview frames are bare iframe documents with no front matter to fix;
    // auditing them reports short titles and missing descriptions nobody ships.
    const dir = await build({
      "blume-examples/card/index.html": page("card"),
      "docs/blume-examples/counter/index.html": page("counter"),
      "index.html": page("Home"),
    });
    const result = await crawlStaticDir({
      basePath: "/docs",
      manifest: manifest([]),
      staticDir: dir,
    });
    // Both spellings are excluded: with the basePath baked into the built
    // tree, and without.
    expect(result.pages.map((p) => p.url)).toEqual(["/"]);
  });

  it("joins a built page to the source file in the route manifest", async () => {
    // This join is the feature: without it a finding can only name a URL.
    const dir = await build({ "docs/api/index.html": page("API") });
    const result = await crawlStaticDir({
      basePath: "",
      manifest: manifest([
        { path: "/docs/api", sourcePath: "/src/docs/api.mdx" },
      ] as BlumeManifest["routes"]),
      staticDir: dir,
    });
    expect(result.pages[0]?.source).toBe("/src/docs/api.mdx");
  });

  it("matches a route whether or not the built tree carries the base path", async () => {
    const dir = await build({ "guide/index.html": page("Guide") });
    const result = await crawlStaticDir({
      basePath: "/docs",
      manifest: manifest([
        { path: "/docs/guide", sourcePath: "/src/guide.mdx" },
      ] as BlumeManifest["routes"]),
      staticDir: dir,
    });
    expect(result.pages[0]?.source).toBe("/src/guide.mdx");
  });

  it("skips component fragments that are not real documents", async () => {
    const dir = await build({
      "_home/Footer/index.html": "<!doctype html><footer>Not a page.</footer>",
      "index.html": page("Home"),
    });
    const result = await crawlStaticDir({
      basePath: "",
      manifest: manifest([]),
      staticDir: dir,
    });
    expect(result.pages.map((p) => p.url)).toEqual(["/"]);
  });

  it("reports no sitemap or robots when the build has none", async () => {
    const dir = await build({ "index.html": page("Home") });
    const result = await crawlStaticDir({
      basePath: "",
      manifest: manifest([]),
      staticDir: dir,
    });
    expect(result.sitemap).toBeNull();
    expect(result.robots).toBeNull();
  });
});

describe("parseSitemap lastmod", () => {
  it("keys each lastmod by its own loc", () => {
    const doc = parseSitemap(
      "/dist/sitemap.xml",
      `<urlset>
        <url><loc>https://x.dev/a</loc><lastmod>2026-01-01</lastmod></url>
        <url><loc>https://x.dev/b</loc></url>
      </urlset>`,
      200
    );
    expect(doc.lastmod?.get("https://x.dev/a")).toBe("2026-01-01");
    expect(doc.lastmod?.has("https://x.dev/b")).toBe(false);
    expect(doc.urls).toEqual(["https://x.dev/a", "https://x.dev/b"]);
  });
});

describe("parseLlms", () => {
  it("collects Markdown link targets with their line numbers", () => {
    const doc = parseLlms(
      "/dist/llms.txt",
      "# Site\n\n## Docs\n\n- [A](https://x.dev/a): One.\n- [B](/b)\n"
    );
    expect(doc.entries).toEqual([
      { line: 5, url: "https://x.dev/a" },
      { line: 6, url: "/b" },
    ]);
  });
});

describe("pageSite", () => {
  const source = "/docs/api.mdx";
  const text = "---\ntitle: API\ndescription: A description.\n---\n\nBody.\n";

  it("anchors a finding to the front matter line that fixes it", () => {
    // Ahrefs can only say "/docs/api has a bad description". Blume puts the
    // cursor on docs/api.mdx line 3.
    const ctx = context({ sources: new Map([[source, text]]) });
    const site = pageSite(ctx, snapshot({ source, url: "/docs/api" }), [
      "description",
    ]);
    expect(site).toMatchObject({ file: source, line: 3, url: "/docs/api" });
  });

  it("anchors to the file when the key is absent", () => {
    // A *missing* description has no line to point at, so the file alone is it.
    const ctx = context({
      sources: new Map([[source, "---\ntitle: API\n---\n"]]),
    });
    const site = pageSite(ctx, snapshot({ source, url: "/docs/api" }), [
      "description",
    ]);
    expect(site.line).toBeUndefined();
    expect(site.file).toBe(source);
  });

  it("falls back to the URL alone for a page with no source", () => {
    expect(pageSite(context(), snapshot({ url: "/x" }))).toEqual({ url: "/x" });
  });
});

const run = (module: { run: (c: never) => unknown }, ctx: unknown): string[] =>
  codes(module.run(ctx as never) as Diagnostic[]);

describe("uncommon branches", () => {
  it("ignores a malformed absolute href", () => {
    expect(resolveHref("/", "https://", SITE)).toEqual({ kind: "ignored" });
  });

  it("reports an hreflang href that is not an absolute URL", () => {
    const ctx = context({
      pages: [snapshot({ hreflang: [{ href: "/fr", lang: "fr" }], url: "/" })],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_BAD_TARGET");
  });

  it("reports an hreflang pointing at a redirect", () => {
    const ctx = context({
      pages: [
        snapshot({
          hreflang: [
            { href: `${SITE}/`, lang: "en" },
            { href: `${SITE}/old-fr`, lang: "fr" },
            { href: `${SITE}/`, lang: "x-default" },
          ],
          url: "/",
        }),
      ],
      redirects: [{ from: "/old-fr", status: 301, to: "/" }],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_BAD_TARGET");
  });

  it("reports an hreflang pointing at a page that canonicalizes elsewhere", () => {
    const ctx = context({
      pages: [
        snapshot({
          hreflang: [
            { href: `${SITE}/`, lang: "en" },
            { href: `${SITE}/fr`, lang: "fr" },
            { href: `${SITE}/`, lang: "x-default" },
          ],
          url: "/",
        }),
        snapshot({ canonical: `${SITE}/elsewhere`, lang: "fr", url: "/fr" }),
      ],
      site: SITE,
    });
    expect(run(i18nChecks, ctx)).toContain("HREFLANG_BAD_TARGET");
  });

  it("ignores an unparseable canonical when checking the sitemap", () => {
    const ctx = context({
      pages: [snapshot({ canonical: "not a url", url: "/" })],
      site: SITE,
      sitemap: { bytes: 10, file: "/dist/sitemap.xml", urls: [`${SITE}/`] },
    });
    // CANONICAL_BAD_TARGET reports the malformed canonical; the sitemap check
    // must not also crash or double-report it.
    expect(run(sitemapChecks, ctx)).not.toContain("NON_CANONICAL_IN_SITEMAP");
  });
});
