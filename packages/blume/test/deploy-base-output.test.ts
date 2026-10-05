import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { resolveRedirects } from "../src/audit/redirects.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { cloudflare, vercel } from "../src/deploy/adapters/index.ts";
import { emitHeaderFiles } from "../src/deploy/artifacts.ts";
import {
  buildNegotiationWorker,
  buildRunWorkerFirstRules,
  NEGOTIATION_WORKER_FILE,
} from "../src/deploy/cloudflare-negotiation.ts";
import { emitCloudflareNegotiation } from "../src/deploy/platforms/cloudflare.ts";
import type { BuildLog } from "../src/deploy/platforms/index.ts";
import { vercelPlatform } from "../src/deploy/platforms/vercel.ts";
import {
  applyBaseToAstroRedirects,
  applyBaseToPlatformRedirects,
  buildVercelConfig,
  platformRedirects,
} from "../src/deploy/redirects.ts";
import { buildRssFeeds } from "../src/deploy/rss.ts";
import { buildSitemapFiles } from "../src/deploy/sitemap.ts";
import {
  ACCEPT_MARKDOWN_CONDITIONS,
  injectNegotiationRoutes,
  rebaseAdapterRoutes,
} from "../src/deploy/vercel-negotiation.ts";
import type { VercelRoute } from "../src/deploy/vercel-negotiation.ts";

// Deploy output under `deployment.base` and `basePath`: generated URLs always
// mount under the deployment base, a redirect to a public file never gains
// `basePath`, Vercel reads each redirect `from` as a literal path, a
// Cloudflare server build keeps `_headers` and the 404 twins where the
// platform reads them once `@astrojs/cloudflare` moves the client output
// under the base (`dist/client/<base>/`), and a Vercel server build moves
// the static files and routes `@astrojs/vercel` leaves at the root under it.

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const writeTree = async (
  root: string,
  files: Record<string, string>
): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    })
  );
};

/** A scanned project with `config` as its `blume.config.ts` default export. */
const project = async (
  config: string,
  files: Record<string, string> = {}
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-deploy-base-"));
  dirs.push(root);
  await writeTree(root, {
    "blume.config.ts": `export default ${config};\n`,
    "docs/index.md": "# Home\n",
    "docs/intro.md": "# Intro\n",
    ...files,
  });
  return scanProject(root, { mode: "build" });
};

const quiet = { info: () => {}, warn: () => {} };

describe("generated URLs under a deployment base that matches a route", () => {
  it("mounts sitemap and feed entries under the base", async () => {
    // `blog/hello.md` routes to `/blog/hello`, which base `/blog` serves at
    // `/blog/blog/hello` — the route merely starts with the base's segment.
    const built = await project(
      '{ deployment: { base: "/blog", site: "https://example.com" }, seo: { rss: { types: ["blog"] } } }',
      {
        "docs/blog/hello.md":
          "---\ndate: 2026-01-01\ntype: blog\n---\n# Hello\n",
      }
    );
    const sitemap = buildSitemapFiles(built)?.[0]?.xml ?? "";
    expect(sitemap).toContain("<loc>https://example.com/blog/blog/hello</loc>");
    expect(sitemap).toContain("<loc>https://example.com/blog/intro</loc>");
    expect(sitemap).toContain("<loc>https://example.com/blog</loc>");
    const [feed] = buildRssFeeds(built);
    expect(feed?.items.map((item) => item.link)).toStrictEqual([
      "https://example.com/blog/blog/hello",
    ]);
  });
});

describe("redirects to public files", () => {
  const redirects = [
    { from: "/old-paper", status: 301 as const, to: "/files/whitepaper.pdf" },
    { from: "/latest", status: 302 as const, to: "/releases/v1.2" },
    { from: "/old-intro", status: 301 as const, to: "/intro#setup" },
  ];
  // A dotted page route is still a page, not a file.
  const routes = new Set(["/docs/intro", "/docs/releases/v1.2"]);

  it("never gives a file target basePath", () => {
    expect(
      applyBaseToAstroRedirects(redirects, "/docs", "", routes).map(
        (redirect) => redirect.to
      )
    ).toStrictEqual([
      "/files/whitepaper.pdf",
      "/docs/releases/v1.2",
      "/docs/intro#setup",
    ]);
  });

  it("gives a file target the deployment base alone", () => {
    expect(
      applyBaseToAstroRedirects(redirects, "/docs", "/base", routes).map(
        (redirect) => redirect.to
      )
    ).toStrictEqual([
      "/base/files/whitepaper.pdf",
      "/base/docs/releases/v1.2",
      "/base/docs/intro#setup",
    ]);
    expect(
      applyBaseToPlatformRedirects(redirects, "/docs", "/base", routes)
    ).toStrictEqual([
      {
        from: "/base/docs/old-paper",
        status: 301,
        to: "/base/files/whitepaper.pdf",
      },
      {
        from: "/base/docs/latest",
        status: 302,
        to: "/base/docs/releases/v1.2",
      },
      {
        from: "/base/docs/old-intro",
        status: 301,
        to: "/base/docs/intro#setup",
      },
    ]);
  });

  it("resolves in the audit, which bases redirects the way the build does", () => {
    // `runAudit` checks redirects against the built, base-less URLs, so it
    // bases them with the build's own `applyBaseToAstroRedirects`.
    const [paper] = resolveRedirects(
      applyBaseToAstroRedirects(redirects, "/docs", "", routes),
      (path) => path === "/files/whitepaper.pdf"
    );
    expect(paper?.outcome).toBe("ok");
    expect(paper?.chain).toStrictEqual([
      "/docs/old-paper",
      "/files/whitepaper.pdf",
    ]);
  });

  it("reads the served pages from the manifest in platformRedirects", async () => {
    const built = await project(
      `{ basePath: "/docs", redirects: ${JSON.stringify(redirects)} }`,
      { "docs/releases/v1.2.md": "# v1.2\n" }
    );
    expect(
      platformRedirects(built).map((redirect) => redirect.to)
    ).toStrictEqual([
      "/files/whitepaper.pdf",
      "/docs/releases/v1.2",
      // The page's Markdown copies move with it; a file has none.
      "/docs/releases/v1.2.md",
      "/docs/releases/v1.2.mdx",
      "/docs/intro#setup",
    ]);
  });
});

describe("vercel.json redirect sources", () => {
  it("escapes the characters path-to-regexp reads as syntax", () => {
    const parsed = JSON.parse(
      buildVercelConfig([
        { from: "/c++-guide", status: 301, to: "/cpp-guide" },
        { from: "/faq(old)", status: 301, to: "/faq" },
        { from: "/what?", status: 301, to: "/what" },
        { from: "/a:b/{x}", status: 301, to: "/ab" },
        { from: "/plain/path", status: 301, to: "/new" },
      ])
    );
    expect(
      parsed.redirects.map(
        (redirect: { destination: string; source: string }) => redirect.source
      )
    ).toStrictEqual([
      String.raw`/c\+\+-guide`,
      String.raw`/faq\(old\)`,
      String.raw`/what\?`,
      String.raw`/a\:b/\{x\}`,
      "/plain/path",
    ]);
    // Destinations are not patterns to match, so they ship as written.
    expect(parsed.redirects[0].destination).toBe("/cpp-guide");
  });
});

describe("Cloudflare negotiation with a bare deployment base", () => {
  it("claims the base with a leading slash", () => {
    const rules = buildRunWorkerFirstRules("docs");
    expect(rules.slice(0, 3)).toStrictEqual([
      "/docs",
      "/docs/*",
      "!/docs/_astro/*",
    ]);
    expect(rules.every((rule) => rule.replace(/^!/u, "").startsWith("/"))).toBe(
      true
    );
  });

  it("strips the base the Worker sees from each request", () => {
    const worker = buildNegotiationWorker({
      assetsBinding: "ASSETS",
      base: "docs/",
      mainSpecifier: "./index.js",
      routePaths: ["/", "/intro"],
    });
    expect(worker).toContain('const BASE_PREFIX = "/docs";');
  });
});

describe("Cloudflare server build under a base", () => {
  const ADAPTER_RULE =
    "/docs/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n";

  it("writes _headers at the assets root the adapter hoisted its own to", async () => {
    const built = await project(
      `{ deployment: ${JSON.stringify(cloudflare({ base: "/docs" }))} }`,
      { "dist/client/_headers": ADAPTER_RULE }
    );
    const clientDir = join(built.context.root, "dist", "client");
    // What Astro hands `astro:build:done` once the adapter moved the output.
    await emitHeaderFiles(built, join(clientDir, "docs"), quiet);
    const headers = await readFile(join(clientDir, "_headers"), "utf-8");
    expect(headers.startsWith(ADAPTER_RULE.trimEnd())).toBe(true);
    expect(headers).toContain(
      "/docs/*.md\n  Content-Type: text/markdown; charset=utf-8"
    );
    expect(existsSync(join(clientDir, "docs", "_headers"))).toBe(false);
  });

  it("climbs every segment of a nested base", async () => {
    const built = await project(
      `{ deployment: ${JSON.stringify(cloudflare({ base: "/a/b/" }))} }`,
      { "dist/client/a/b/index.html": "<h1>Home</h1>\n" }
    );
    const clientDir = join(built.context.root, "dist", "client");
    await emitHeaderFiles(built, join(clientDir, "a", "b"), quiet);
    expect(await readFile(join(clientDir, "_headers"), "utf-8")).toContain(
      "/a/b/*.md"
    );
  });

  it("keeps _headers in the reported directory for a static build", async () => {
    const built = await project(
      `{ deployment: ${JSON.stringify(
        cloudflare({ base: "/docs", output: "static" })
      )} }`,
      { "dist/index.html": "<h1>Home</h1>\n" }
    );
    const distDir = join(built.context.root, "dist");
    await emitHeaderFiles(built, distDir, quiet);
    expect(existsSync(join(distDir, "_headers"))).toBe(true);
  });

  it("wires the 404 twins the adapter wrote under the base", async () => {
    const built = await project(
      `{ deployment: ${JSON.stringify(cloudflare({ base: "docs" }))} }`,
      {
        "dist/client/docs/404.json": "{}\n",
        "dist/client/docs/404.md": "# Page not found\n",
        "dist/server/wrangler.json": JSON.stringify({
          assets: { binding: "ASSETS", directory: "../client" },
          main: "index.js",
          name: "docs",
        }),
      }
    );
    await emitCloudflareNegotiation(built, {
      error: () => {},
      info: () => {},
      success: () => {},
      warn: () => {},
    });
    const serverDir = join(built.context.root, "dist", "server");
    const worker = await readFile(
      join(serverDir, NEGOTIATION_WORKER_FILE),
      "utf-8"
    );
    expect(worker).toContain(
      'const NOT_FOUND = {"json":true,"markdown":true};'
    );
    expect(worker).toContain('const BASE_PREFIX = "/docs";');
    const wrangler: { assets: { run_worker_first: string[] } } = JSON.parse(
      await readFile(join(serverDir, "wrangler.json"), "utf-8")
    );
    expect(wrangler.assets.run_worker_first[0]).toBe("/docs");
  });
});

/**
 * The routing config `@astrojs/vercel` writes for a server build under
 * `/docs`, trimmed to one route of each kind: its patterns match base-less
 * paths, and its redirect from `/old-intro` to the page at `/docs/intro`
 * lost a slash on one side and doubled the base on the other.
 */
const VERCEL_ADAPTER_ROUTES: VercelRoute[] = [
  { headers: { Location: "/$1" }, src: "^/(.*)/$", status: 308 },
  {
    headers: { Location: "/docs/docs/intro" },
    src: "^/docsold-intro$",
    status: 301,
  },
  { handle: "filesystem" },
  {
    continue: true,
    headers: { "cache-control": "public, max-age=31536000, immutable" },
    src: "^/_astro/(.*)$",
  },
  { dest: "_render", src: "^/_server-islands/([^/]+?)$" },
  { dest: "_render", src: "^/api(?:/(.*?))?$" },
  { dest: "_render", src: "^/old-intro$" },
  { dest: "/404.html", src: "^/.*$", status: 404 },
];

const vercelConfig = (routes: VercelRoute[]): string =>
  JSON.stringify({ routes, version: 3 });

const routesOf = (text: string | null): VercelRoute[] =>
  JSON.parse(text ?? "{}").routes;

const REDIRECT_TO_INTRO: VercelRoute = {
  headers: { Location: "/docs/intro" },
  src: "^/docs/old-intro/?$",
  status: 301,
};

describe("rebaseAdapterRoutes", () => {
  it("moves every adapter route under the base and swaps in the redirects", () => {
    expect(
      routesOf(
        rebaseAdapterRoutes(vercelConfig(VERCEL_ADAPTER_ROUTES), "/docs", [
          REDIRECT_TO_INTRO,
        ])
      )
    ).toStrictEqual([
      // Strips the slash from any path, base and all.
      { headers: { Location: "/$1" }, src: "^/(.*)/$", status: 308 },
      REDIRECT_TO_INTRO,
      { handle: "filesystem" },
      {
        continue: true,
        headers: { "cache-control": "public, max-age=31536000, immutable" },
        src: "^/docs/_astro/(.*)$",
      },
      { dest: "_render", src: "^/docs/_server-islands/([^/]+?)$" },
      { dest: "_render", src: "^/docs/api(?:/(.*?))?$" },
      { dest: "_render", src: "^/docs/old-intro$" },
      { dest: "/docs/404.html", src: "^/docs/.*$", status: 404 },
    ]);
  });

  it("serves the root routes at the base itself", () => {
    const routes = routesOf(
      rebaseAdapterRoutes(
        vercelConfig([
          // A header route the adapter splices in as a bare pathname.
          { continue: true, headers: { "x-page": "home" }, src: "/" },
          { handle: "filesystem" },
          { dest: "_render", src: "^/$" },
          { dest: "_render", src: "^(?:/(.*?))?$" },
        ]),
        "/my.docs",
        []
      )
    );
    expect(routes.map((route) => route.src)).toStrictEqual([
      String.raw`^/my\.docs$`,
      undefined,
      String.raw`^/my\.docs$`,
      String.raw`^/my\.docs(?:/(.*?))?$`,
    ]);
  });

  it("refuses a config it can't splice into", () => {
    expect(rebaseAdapterRoutes("not json", "/docs", [])).toBeNull();
    expect(rebaseAdapterRoutes("{}", "/docs", [])).toBeNull();
    expect(
      rebaseAdapterRoutes(vercelConfig([{ src: "^/$" }]), "/docs", [])
    ).toBeNull();
  });
});

/** Every negotiation route, for the home page and `/intro`, under `/docs`. */
const injectUnderDocs = (text: string): string | null =>
  injectNegotiationRoutes(
    text,
    ["/", "/intro"],
    "</docs/llms.txt>",
    {},
    12,
    { json: true, markdown: true },
    ["/.well-known/ai-catalog.json"],
    true,
    "/docs"
  );

describe("Vercel negotiation under a base", () => {
  const rebased =
    rebaseAdapterRoutes(vercelConfig(VERCEL_ADAPTER_ROUTES), "/docs", []) ?? "";

  it("matches and names the served paths", () => {
    const routes = routesOf(injectUnderDocs(rebased));
    const bySrc = (src: string) => routes.filter((route) => route.src === src);
    expect(bySrc("^(?:/docs|/docs/intro)/?$")).toHaveLength(1);
    // The Link header, then the rewrite once per pair of `accept` conditions.
    expect(bySrc("^/docs$").map((route) => route.dest)).toStrictEqual([
      undefined,
      "/docs/index.md",
      "/docs/index.md",
    ]);
    expect(
      bySrc("^(/docs/intro)/?$").map((route) => [route.dest, route.missing])
    ).toStrictEqual([
      ["$1.md", undefined],
      ["$1.md", ACCEPT_MARKDOWN_CONDITIONS[1]?.missing],
    ]);
    expect(
      bySrc(String.raw`^/docs/\.well-known/ai-catalog\.json$`)
    ).toHaveLength(1);
    expect(bySrc(String.raw`^/docs/blume-assets/.+\.svg$`)).toHaveLength(1);
    // The 404 twins sit right ahead of the fallback the rebase moved.
    expect(routes.slice(-7).map((route) => route.dest)).toStrictEqual([
      "/docs/404.md",
      "/docs/404.md",
      "/docs/404.md",
      "/docs/404.json",
      "/docs/404.json",
      "/docs/404.json",
      "/docs/404.html",
    ]);
    expect(routes.at(-3)?.src).toBe("^/docs/.*$");
    expect(routes.at(-2)?.src).toBe(String.raw`^/docs/.*\.json$`);
  });

  it("replaces its own routes when injected again", () => {
    const once = injectUnderDocs(rebased) ?? "";
    expect(injectUnderDocs(once)).toBe(once);
  });
});

/** A build log that keeps the errors. */
const errorRecorder = () => {
  const errors: string[] = [];
  const log: BuildLog = {
    error: (message) => errors.push(message),
    info: () => {},
    success: () => {},
    warn: () => {},
  };
  return { errors, log };
};

const vercelProject = async (
  base: string,
  files: Record<string, string>
): Promise<BlumeProject> =>
  await project(
    `{ deployment: ${JSON.stringify(vercel({ base }))}, redirects: ${JSON.stringify(
      [
        { from: "/old-intro", status: 301, to: "/intro" },
        { from: "/beta/:slug*", status: 302, to: "/intro" },
      ]
    )} }`,
    files
  );

describe("Vercel server build under a base", () => {
  const BUILT = {
    ".vercel/output/static/404.md": "# Page not found\n",
    ".vercel/output/static/_astro/page.js": "export {};\n",
    ".vercel/output/static/index.html": "<h1>Home</h1>\n",
  };

  it("serves the static files and routes from the base", async () => {
    const built = await vercelProject("/docs", {
      ...BUILT,
      ".vercel/output/config.json": vercelConfig(VERCEL_ADAPTER_ROUTES),
    });
    const { errors, log } = errorRecorder();
    expect(
      await vercelPlatform.finalizeBuild?.({
        isolated: false,
        log,
        project: built,
      })
    ).toBe(true);
    expect(errors).toStrictEqual([]);
    const outputDir = join(built.context.root, ".vercel", "output");
    const staticDir = join(outputDir, "static");
    expect(existsSync(join(staticDir, "docs", "_astro", "page.js"))).toBe(true);
    expect(existsSync(join(staticDir, "docs", "index.html"))).toBe(true);
    expect(existsSync(join(staticDir, "index.html"))).toBe(false);
    const routes = routesOf(
      await readFile(join(outputDir, "config.json"), "utf-8")
    );
    const srcs = routes.map((route) => route.src);
    expect(srcs).not.toContain("^/docsold-intro$");
    // The exact redirect and its Markdown copies, rebuilt ahead of the
    // pattern ones.
    const redirects = routes.filter((route) => route.headers?.Location);
    expect(redirects.slice(1)).toStrictEqual([
      REDIRECT_TO_INTRO,
      {
        headers: { Location: "/docs/intro.md" },
        src: String.raw`^/docs/old-intro\.md/?$`,
        status: 301,
      },
      {
        headers: { Location: "/docs/intro.mdx" },
        src: String.raw`^/docs/old-intro\.mdx/?$`,
        status: 301,
      },
      {
        headers: { Location: "/docs/intro" },
        src: "^/docs/beta/?$",
        status: 302,
      },
      {
        headers: { Location: "/docs/intro" },
        src: "^/docs/beta/(.+?)/?$",
        status: 302,
      },
    ]);
    expect(srcs).toContain("^/docs/_astro/(.*)$");
    expect(routes.at(-1)?.dest).toBe("/docs/404.html");
    expect(routes.at(-2)?.dest).toBe("/docs/404.md");
  });

  it("moves the static files of a verify build without routing them", async () => {
    const built = await vercelProject("/a/b/", {
      ...BUILT,
      ".vercel/output/config.json": vercelConfig(VERCEL_ADAPTER_ROUTES),
    });
    const { log } = errorRecorder();
    expect(
      await vercelPlatform.finalizeBuild?.({
        isolated: true,
        log,
        project: built,
      })
    ).toBe(true);
    const outputDir = join(built.context.root, ".vercel", "output");
    expect(
      existsSync(join(outputDir, "static", "a", "b", "_astro", "page.js"))
    ).toBe(true);
    expect(await readFile(join(outputDir, "config.json"), "utf-8")).toBe(
      vercelConfig(VERCEL_ADAPTER_ROUTES)
    );
  });

  it("passes a build with no routing config", async () => {
    const built = await vercelProject("/docs", {});
    const { errors, log } = errorRecorder();
    expect(
      await vercelPlatform.finalizeBuild?.({
        isolated: false,
        log,
        project: built,
      })
    ).toBe(true);
    expect(errors).toStrictEqual([]);
  });

  it("refuses to ship routes it couldn't move under the base", async () => {
    const built = await vercelProject("/docs", {
      ".vercel/output/config.json": "not json",
    });
    const { errors, log } = errorRecorder();
    expect(
      await vercelPlatform.finalizeBuild?.({
        isolated: false,
        log,
        project: built,
      })
    ).toBe(false);
    expect(errors[0]).toContain('deployment base "/docs"');
  });
});
