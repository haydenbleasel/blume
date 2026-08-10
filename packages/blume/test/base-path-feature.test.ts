import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildLlmsFiles } from "../src/ai/llms.ts";
import {
  isInternalPath,
  normalizeBasePath,
  normalizeRoute,
  stripBasePath,
  withBasePath,
  withComposedBasePath,
} from "../src/core/base-path.ts";
import { validateLinks } from "../src/core/links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { pageMetaSchema } from "../src/core/schema.ts";
import type { ContentGraph, PageLink, PageRecord } from "../src/core/types.ts";
import { buildSitemapFiles } from "../src/deploy/sitemap.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalizeBasePath", () => {
  it("canonicalizes to `` or /seg", () => {
    expect(normalizeBasePath()).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("docs")).toBe("/docs");
    expect(normalizeBasePath("/docs/")).toBe("/docs");
    expect(normalizeBasePath("  /docs  ")).toBe("/docs");
    expect(normalizeBasePath("//a//b//")).toBe("/a/b");
  });
});

describe("normalizeRoute", () => {
  it("canonicalizes to / or /seg with one leading slash", () => {
    expect(normalizeRoute("")).toBe("/");
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("///")).toBe("/");
    expect(normalizeRoute("docs")).toBe("/docs");
    expect(normalizeRoute("/docs/")).toBe("/docs");
    expect(normalizeRoute("  api/events  ")).toBe("/api/events");
  });
});

describe("isInternalPath", () => {
  it("accepts root-relative paths, rejects everything else", () => {
    expect(isInternalPath("/x")).toBe(true);
    expect(isInternalPath("//host")).toBe(false);
    expect(isInternalPath("https://x.com")).toBe(false);
    expect(isInternalPath("mailto:a@b.c")).toBe(false);
    expect(isInternalPath("#anchor")).toBe(false);
    expect(isInternalPath("relative/path")).toBe(false);
  });
});

describe("withBasePath", () => {
  it("prepends the base to internal routes", () => {
    expect(withBasePath("/docs", "/guide")).toBe("/docs/guide");
    expect(withBasePath("/docs", "/")).toBe("/docs");
  });

  it("is idempotent for already-based routes", () => {
    expect(withBasePath("/docs", "/docs")).toBe("/docs");
    expect(withBasePath("/docs", "/docs/guide")).toBe("/docs/guide");
    // A sibling that merely shares the prefix substring is still based.
    expect(withBasePath("/docs", "/documentation")).toBe("/docs/documentation");
  });

  it("leaves external and empty bases untouched", () => {
    expect(withBasePath("/docs", "https://x.com")).toBe("https://x.com");
    expect(withBasePath("/docs", "//host")).toBe("//host");
    expect(withBasePath("/docs", "#h")).toBe("#h");
    expect(withBasePath("", "/guide")).toBe("/guide");
  });
});

describe("withComposedBasePath", () => {
  it("stacks deployment.base over basePath", () => {
    expect(withComposedBasePath("/base", "/docs", "/guide")).toBe(
      "/base/docs/guide"
    );
    expect(withComposedBasePath("/base", "/docs", "/")).toBe("/base/docs");
  });

  it("adds only the deployment base to a hand-written basePath link", () => {
    // The promise from markdown/base-links.ts: an author who writes the
    // basePath by hand (`/docs/x`) isn't double-prefixed to `/docs/docs/x`.
    expect(withComposedBasePath("/base", "/docs", "/docs/guide")).toBe(
      "/base/docs/guide"
    );
    expect(withComposedBasePath("/base", "/docs", "/docs")).toBe("/base/docs");
  });

  it("leaves a route already under the full composite unchanged", () => {
    expect(withComposedBasePath("/base", "/docs", "/base/docs/guide")).toBe(
      "/base/docs/guide"
    );
    expect(withComposedBasePath("/base", "/docs", "/base/docs")).toBe(
      "/base/docs"
    );
  });

  it("degenerates to withBasePath when a layer is empty", () => {
    expect(withComposedBasePath("", "/docs", "/guide")).toBe("/docs/guide");
    expect(withComposedBasePath("/base", "", "/guide")).toBe("/base/guide");
    expect(withComposedBasePath("", "", "/guide")).toBe("/guide");
  });

  it("passes non-internal targets through", () => {
    expect(withComposedBasePath("/base", "/docs", "https://x.com")).toBe(
      "https://x.com"
    );
    expect(withComposedBasePath("/base", "/docs", "#h")).toBe("#h");
  });
});

describe("stripBasePath", () => {
  it("removes the base, inverse of withBasePath", () => {
    expect(stripBasePath("/docs", "/docs/guide")).toBe("/guide");
    expect(stripBasePath("/docs", "/docs")).toBe("/");
    expect(stripBasePath("/docs", "/other")).toBe("/other");
    expect(stripBasePath("", "/docs/guide")).toBe("/docs/guide");
  });
});

// ---------------------------------------------------------------------------
// Markdown link rewrite
// ---------------------------------------------------------------------------

const renderMd = async (
  processor: ReturnType<typeof blumeMarkdownProcessor>,
  source: string
): Promise<string> => {
  const renderer = await processor.createRenderer({});
  const result = await renderer.render(source);
  return result.code;
};

describe("markdown base-links plugin", () => {
  it("prepends the base to internal page links, leaving assets and externals", async () => {
    const html = await renderMd(
      blumeMarkdownProcessor({ basePath: "/docs" }),
      [
        "[Guide](/guides/intro)",
        "[Docs home](/)",
        "[External](https://example.com)",
        "[PDF](/spec.pdf)",
        "[Anchor](#section)",
        "![Logo](/logo.svg)",
      ].join("\n\n")
    );
    expect(html).toContain('href="/docs/guides/intro"');
    // The root link maps to the base itself.
    expect(html).toContain('href="/docs">Docs home');
    expect(html).toContain('href="https://example.com"');
    // Asset links and images are served from public/ at the root — not based.
    expect(html).toContain('href="/spec.pdf"');
    expect(html).toContain('src="/logo.svg"');
    expect(html).toContain('href="#section"');
  });

  it("layers deployment.base without double-prefixing a hand-written basePath", async () => {
    const html = await renderMd(
      blumeMarkdownProcessor({ basePath: "/docs", deployBase: "/base" }),
      [
        "[Guide](/guide)",
        "[Hand-written](/docs/guide)",
        "[Composed](/base/docs/guide)",
      ].join("\n\n")
    );
    // All three authored forms resolve to the same served URL.
    expect(html).toContain('href="/base/docs/guide">Guide');
    expect(html).toContain('href="/base/docs/guide">Hand-written');
    expect(html).toContain('href="/base/docs/guide">Composed');
    expect(html).not.toContain("/base/docs/docs/");
  });

  it("rewrites under deployment.base alone when no basePath is set", async () => {
    const html = await renderMd(
      blumeMarkdownProcessor({ deployBase: "/base" }),
      "[Guide](/guide)"
    );
    expect(html).toContain('href="/base/guide"');
  });

  it("is a no-op without a base, and works in the MDX processor too", async () => {
    const plain = await renderMd(
      blumeMarkdownProcessor({}),
      "[Guide](/guides/intro)"
    );
    expect(plain).toContain('href="/guides/intro"');

    const mdx = await renderMd(
      blumeMdxProcessor({ basePath: "/docs" }) as unknown as ReturnType<
        typeof blumeMarkdownProcessor
      >,
      "[Guide](/guides/intro)"
    );
    expect(mdx).toContain('href="/docs/guides/intro"');
  });
});

// ---------------------------------------------------------------------------
// Full pipeline (scanProject) under a base path
// ---------------------------------------------------------------------------

const dirs: string[] = [];

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-base-"));
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
    'export default { basePath: "/manual", deployment: { site: "https://example.com" } };\n',
  "docs/getting-started.md": "# Getting started\n",
  "docs/guides/intro.md": "# Intro\n",
  "docs/index.md": "# Home\n",
};

describe("content pipeline under basePath", () => {
  it("bakes the base into routes but keeps nav base-less", async () => {
    const project = await scanProject(await makeProject(FIXTURE), {
      mode: "build",
    });

    // Every route carries the base.
    expect(
      project.manifest.routes.map((route) => route.path).toSorted()
    ).toStrictEqual([
      "/manual",
      "/manual/getting-started",
      "/manual/guides/intro",
    ]);

    // navPath (the nav-tree structure key) stays base-less.
    for (const page of project.graph.pages) {
      expect(page.navPath.startsWith("manual")).toBe(false);
    }

    // The sidebar's top level is the sections themselves — no "manual" wrapper
    // group — and the one real group carries a based URL.
    const { sidebar } = project.graph.navigation;
    expect(sidebar.some((node) => node.label.toLowerCase() === "manual")).toBe(
      false
    );
    const guides = sidebar.find((node) => node.kind === "group");
    expect(guides?.kind === "group" ? guides.path : undefined).toBe(
      "/manual/guides"
    );
  });

  it("flows the base through the sitemap and llms.txt", async () => {
    const project = await scanProject(await makeProject(FIXTURE), {
      mode: "build",
    });

    const sitemap = buildSitemapFiles(project)?.[0]?.xml ?? "";
    expect(sitemap).toContain("https://example.com/manual/getting-started");

    const { index, full } = await buildLlmsFiles(project);
    expect(index).toContain("https://example.com/manual/getting-started");
    expect(full).toContain("https://example.com/manual/getting-started");
  });
});

// ---------------------------------------------------------------------------
// Internal-link validation under a base path
// ---------------------------------------------------------------------------

const link = (target: string): PageLink => ({ column: 1, line: 1, target });

const makePage = (
  route: string,
  links: PageLink[],
  navPath: string
): PageRecord => ({
  contentType: "doc",
  format: "mdx",
  groups: [],
  headings: [],
  id: route,
  links,
  locale: "",
  meta: pageMetaSchema.parse({}),
  navPath,
  route,
  segments: [],
  source: { name: "filesystem", ref: navPath },
  sourcePath: `/abs/${navPath}.mdx`,
  title: route,
  translationKey: navPath,
  version: "",
  versionKey: navPath,
});

const makeGraph = (pages: PageRecord[]): ContentGraph =>
  ({
    diagnostics: [],
    navigation: { featured: [], selectors: [], sidebar: [], tabs: [] },
    navigationByLocale: {},
    navigationByVersion: {},
    pages,
    routes: new Map(pages.map((page) => [page.route, page.id])),
  }) as ContentGraph;

describe("validateLinks under basePath", () => {
  it("resolves author-written root-relative links against the based routes", async () => {
    const pages = [
      // Author writes `/guides/intro` as if mounted at root; the target page's
      // real route is `/manual/guides/intro`.
      makePage("/manual/start", [link("/guides/intro")], "start"),
      makePage("/manual/guides/intro", [], "guides/intro"),
    ];
    const diagnostics = await validateLinks(makeGraph(pages), {
      basePath: "/manual",
      publicDir: null,
    });
    expect(diagnostics.filter((d) => d.severity === "error")).toStrictEqual([]);
  });

  it("still flags a genuinely missing page under a base", async () => {
    const pages = [makePage("/manual/start", [link("/nope")], "start")];
    const diagnostics = await validateLinks(makeGraph(pages), {
      basePath: "/manual",
      publicDir: null,
    });
    expect(diagnostics.some((d) => d.code === "BLUME_BROKEN_LINK")).toBe(true);
  });

  it("treats a configured redirect.from as a valid based target", async () => {
    const pages = [makePage("/manual/start", [link("/old")], "start")];
    const diagnostics = await validateLinks(makeGraph(pages), {
      basePath: "/manual",
      publicDir: null,
      redirects: [{ from: "/old" }],
    });
    expect(diagnostics.filter((d) => d.severity === "error")).toStrictEqual([]);
  });
});
