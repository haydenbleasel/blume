import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { dirname, join, normalize } from "pathe";

import { buildAgentReadability } from "../src/ai/agent-readability.ts";
import { buildAiCatalog } from "../src/ai/ai-catalog.ts";
import { buildApiCatalog } from "../src/ai/api-catalog.ts";
import { buildPagesIndex } from "../src/ai/api/handlers.ts";
import { buildChangelogIndexMarkdown } from "../src/ai/changelog-markdown.ts";
import { downlevelComponents } from "../src/ai/component-markdown.ts";
import { buildLlmsFiles } from "../src/ai/llms.ts";
import { buildRawMarkdown } from "../src/ai/markdown.ts";
import { buildMcpData } from "../src/ai/mcp/data.ts";
import { buildMcpDiscovery } from "../src/ai/mcp/discovery.ts";
import { urlFor } from "../src/ai/mcp/query.ts";
import { createMcpFetchHandler } from "../src/ai/mcp/server.ts";
import { openapiComponentSerializers } from "../src/ai/openapi-components.ts";
import { relativeLinkRewriter } from "../src/ai/relative-links.ts";
import {
  publishRuntimeModules,
  readRuntimeModule,
  RUNTIME_MODULE_FILES,
} from "../src/astro/runtime-modules.ts";
import type { RuntimeModuleId } from "../src/astro/runtime-modules.ts";
import { catchAllPageTemplate } from "../src/astro/templates.ts";
import {
  mountBase,
  prefixBase,
  withMountedBase,
} from "../src/components/islands/base-path.ts";
import { localizeHref } from "../src/core/locale-links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";
import type { ApiSpecData } from "../src/openapi/model.ts";
import { openapi } from "../src/reference/index.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import type { JsonLdNode } from "../src/seo/jsonld.ts";

/**
 * Every URL Blume generates for one of its own routes lands under
 * `deployment.base`, even when the route's first segment is the base's own
 * name: under `base: "/guides"`, `guides/setup.md` is served at
 * `/guides/guides/setup`, so its canonical, sidebar entry, llms.txt line, and
 * agent URLs must say so rather than collapse onto `/guides/setup`. Links an
 * author wrote keep a base written by hand.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scanFixture = async (
  files: Record<string, string>
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-base-generated-routes-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return await scanProject(root);
};

const page = (title: string, body = ""): string =>
  `---\ntitle: ${title}\n---\n\n${body}\n`;

/** A site served under `/guides` with a content folder of the same name. */
const GUIDES = {
  "blume.config.ts":
    'export default { deployment: { base: "/guides", site: "https://example.com" } };',
  "docs/guides/index.md": page("Guides", "Start with [Setup](./setup)."),
  "docs/guides/setup.md": page("Setup", "Setup."),
  "docs/index.md": page("Home", "Home."),
};

describe("the client base helpers", () => {
  it("compare only the path part of an authored link to the base", () => {
    expect(prefixBase("/sub", "/sub#install")).toBe("/sub#install");
    expect(prefixBase("/sub", "/sub?tab=npm")).toBe("/sub?tab=npm");
    expect(prefixBase("/sub", "/sub/guide#x")).toBe("/sub/guide#x");
    // A sibling segment that merely starts with the base still gains it.
    expect(prefixBase("/sub", "/subway#x")).toBe("/sub/subway#x");
    expect(prefixBase("/sub", "/guide#x")).toBe("/sub/guide#x");
  });

  it("mount a generated route under the base unconditionally", () => {
    expect(mountBase("/guides", "/guides/setup")).toBe("/guides/guides/setup");
    expect(mountBase("/guides", "/guides")).toBe("/guides/guides");
    expect(mountBase("/guides/", "/intro")).toBe("/guides/intro");
    expect(mountBase("/guides", "/")).toBe("/guides");
    expect(mountBase("/guides", "/index.md")).toBe("/guides/index.md");
  });

  it("leave a root base and non-internal targets alone", () => {
    expect(mountBase("/", "/guides/setup")).toBe("/guides/setup");
    expect(mountBase("", "/guides/setup")).toBe("/guides/setup");
    expect(mountBase("/guides", "https://x.com/guides")).toBe(
      "https://x.com/guides"
    );
    expect(mountBase("/guides", "//cdn.example.com/a")).toBe(
      "//cdn.example.com/a"
    );
    expect(mountBase("/guides", "#setup")).toBe("#setup");
  });

  it("bind withMountedBase to BASE_URL (unset in tests -> pass-through)", () => {
    expect(withMountedBase("/guides/setup")).toBe("/guides/setup");
  });
});

describe("generated pages render their routes under the base", () => {
  it("mounts the catch-all's canonical, alternates, and OG card", () => {
    const out = catchAllPageTemplate({
      exportEpub: false,
      exportPdf: false,
      mathEnabled: false,
      needsReact: false,
    });
    expect(out).toContain("const basedRoute = withMountedBase(route);");
    expect(out).toContain(
      "const absolute = (path: string) => base + withMountedBase(path);"
    );
    // An authored `seo.image` keeps a hand-written base; the card is mounted.
    expect(out).toContain("? absoluteOg(seo.image, withBase)");
    expect(out).toContain(": ogPath && absoluteOg(ogPath, withMountedBase);");
  });
});

describe("rendered relative links under a base named like a content folder", () => {
  // An absolute path on this platform, as the processors receive from the CLI.
  const root = `${normalize(path.resolve("/site"))}/docs`;
  const snapshot = JSON.stringify({
    config: { i18n: null },
    routes: [
      { entryId: "guides/index.md", path: "/guides" },
      { entryId: "guides/index.mdx", path: "/guides" },
      { entryId: "guides/setup.md", path: "/guides/setup" },
    ].map((route) => ({
      collection: "docs",
      fallback: false,
      locale: "",
      ...route,
    })),
  });

  const options = { contentRoot: root, deployBase: "/guides" };

  /** Run `compile` with the route snapshot published, then restore. */
  const withSnapshot = async (
    compile: () => Promise<string>
  ): Promise<string> => {
    // Publishing replaces the whole module set; put back whatever was there.
    const saved = new Map<RuntimeModuleId, string>();
    for (const id of RUNTIME_MODULE_FILES.keys()) {
      const text = readRuntimeModule(id);
      if (text !== undefined) {
        saved.set(id, text);
      }
    }
    publishRuntimeModules(new Map([...saved, ["blume:data", snapshot]]));
    try {
      return await compile();
    } finally {
      publishRuntimeModules(saved);
    }
  };

  it("links a sibling page at its served URL", async () => {
    const html = await withSnapshot(async () => {
      const renderer = await blumeMarkdownProcessor(options).createRenderer({});
      const result = await renderer.render(
        "[Setup](./setup)\n\n[Hand-based](/guides/setup)",
        { fileURL: pathToFileURL(`${root}/guides/index.md`) }
      );
      return result.code;
    });
    expect(html).toContain('href="/guides/guides/setup"');
    // A root-relative link already under the base is authored: left alone.
    expect(html).toContain('href="/guides/setup"');
  });

  it("links a component's relative href at its served URL", async () => {
    const compiled = await withSnapshot(async () => {
      // JSX elements are only visited on the MDX compile path.
      const processor = blumeMdxProcessor(options);
      if (!processor.createMdxRenderer) {
        throw new Error("The satteri processor has no MDX renderer.");
      }
      const renderer = await processor.createMdxRenderer(
        {},
        { optimize: false }
      );
      const { code } = await renderer.process(
        '<Card href="./setup" title="Setup" />',
        `${root}/guides/index.mdx`,
        {}
      );
      return String(code);
    });
    expect(compiled).toContain('href: "/guides/guides/setup"');
  });
});

describe("agent surfaces under a base named like a content folder", () => {
  it("lists the page at its served URL in llms.txt and llms-full.txt", async () => {
    const project = await scanFixture(GUIDES);
    const { full, index } = await buildLlmsFiles(project);
    expect(index).toContain(
      "- [Setup](https://example.com/guides/guides/setup)"
    );
    expect(index).toContain("- [Home](https://example.com/guides)");
    expect(full).toContain("Source: https://example.com/guides/guides/setup");
  });

  it("points a relative page link at the served route in the mirrors", async () => {
    const project = await scanFixture(GUIDES);
    const raw = await buildRawMarkdown(project);
    expect(raw["/guides"]?.mdx).toContain(
      "Start with [Setup](/guides/guides/setup)."
    );
  });

  it("builds MCP, JSON API, and resource URLs under the base", async () => {
    const project = await scanFixture(GUIDES);
    const data = await buildMcpData(project);
    expect(urlFor("/guides/setup", data)).toBe(
      "https://example.com/guides/guides/setup"
    );
    const setup = buildPagesIndex(data).pages.find(
      (entry) => entry.route === "/guides/setup"
    );
    expect(setup?.url).toBe("https://example.com/guides/guides/setup");

    // Without a site, a resource URI carries the based route, and reading it
    // back strips the base once to find the page.
    const handler = createMcpFetchHandler({ ...data, site: null });
    const rpc = async (method: string, params?: { uri: string }) => {
      const response = await handler(
        new Request("https://example.com/guides/mcp", {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          method: "POST",
        })
      );
      const body: {
        result?: {
          contents?: { text?: string; uri: string }[];
          resources?: { uri: string }[];
        };
      } = await response.json();
      return body.result;
    };
    const listed = await rpc("resources/list");
    const uris = (listed?.resources ?? []).map((resource) => resource.uri);
    expect(uris).toContain("blume:/guides/guides/setup");
    const read = await rpc("resources/read", {
      uri: "blume:/guides/guides/setup",
    });
    expect(read?.contents?.[0]?.text).toContain("Setup.");
  }, 30_000);

  it("addresses an MCP endpoint whose route repeats the base", () => {
    const discovery = buildMcpDiscovery({
      base: "/mcp",
      name: "Docs",
      route: "/mcp",
      site: "https://example.com",
      version: "1.0.0",
    });
    expect(discovery.servers[0]?.url).toBe("https://example.com/mcp/mcp");
  });

  it("links changelog entries under a base named like their folder", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { base: "/changelog", site: "https://example.com" } };',
      "docs/changelog/v1.md":
        "---\ntitle: v1.0.0\ntype: changelog\ndate: 2026-01-15\n---\n\nFirst.\n",
      "docs/index.md": page("Home"),
    });
    expect(buildChangelogIndexMarkdown(project)).toContain(
      "- [v1.0.0](https://example.com/changelog/changelog/v1)"
    );
  });

  it("lists agent artifacts under a base named like their first segment", async () => {
    const project = await scanFixture({
      "blume.config.ts":
        'export default { deployment: { base: "/api", site: "https://example.com" } };',
      "docs/index.md": page("Home"),
    });
    const manifest = buildAgentReadability(project);
    expect(manifest?.artifacts.api?.pages).toBe(
      "https://example.com/api/api/docs/pages.json"
    );
    const data = await buildMcpData(project);
    const home = buildPagesIndex(data).pages.find(
      (entry) => entry.route === "/"
    );
    expect(home?.json).toBe(
      "https://example.com/api/api/docs/pages/index.json"
    );
  });

  it("catalogs a reference whose route repeats the base", () => {
    const config = blumeConfigSchema.parse({
      deployment: { base: "/reference", site: "https://docs.example.com" },
      reference: [openapi({ route: "/reference", spec: "./openapi.json" })],
      title: "Acme",
    });
    const catalog: { entries: { url: string }[] } = JSON.parse(
      buildAiCatalog(config, []) ?? "null"
    );
    expect(catalog.entries.map((entry) => entry.url)).toContain(
      "https://docs.example.com/reference/reference"
    );
    const linkset: { linkset: { anchor: string }[] } = JSON.parse(
      buildApiCatalog(config) ?? "null"
    );
    expect(linkset.linkset.map((entry) => entry.anchor)).toContain(
      "https://docs.example.com/reference/reference"
    );
  });

  it("links an operation whose route repeats the base", () => {
    const spec: ApiSpecData = {
      codeSamples: [],
      description: "",
      // SAFETY: the tag serializer never reads the document.
      document: {} as ApiSpecData["document"],
      expandSchemas: false,
      kind: "openapi",
      label: "API",
      operations: {
        "list-pets": {
          deprecated: false,
          description: "",
          key: "list-pets",
          method: "get",
          path: "/pets",
          route: "/api/pets/list-pets",
          summary: "",
          tag: "pets",
          tagSlug: "pets",
        },
      },
      playground: { enabled: false, proxy: false },
      route: "/api",
      slug: "api",
      tags: [{ description: "", name: "pets", slug: "pets" }],
      title: "Pets",
      version: "1",
    };
    const source = '<ApiTagOperations source="api" tag="pets" />\n';
    expect(
      downlevelComponents(
        source,
        openapiComponentSerializers({ api: spec }, "/api")
      )
    ).toBe("- [`GET /pets`](/api/api/pets/list-pets)\n");
  });
});

describe("JSON-LD under a base named like a content folder", () => {
  it("mounts the page and breadcrumb URLs", () => {
    const data = buildStructuredData({
      base: "/guides",
      breadcrumbs: [
        { label: "Guides", route: "/guides" },
        { label: "Setup", route: "/guides/setup" },
      ],
      description: "d",
      route: "/guides/setup",
      siteName: "Docs",
      siteUrl: "https://example.com",
      title: "Setup",
    });
    // SAFETY: buildStructuredData always emits `@graph` as the node array.
    const graph = (data?.["@graph"] ?? []) as JsonLdNode[];
    const article = graph.find((node) => node["@type"] === "TechArticle");
    expect(article?.url).toBe("https://example.com/guides/guides/setup");
    const crumbs = graph.find((node) => node["@type"] === "BreadcrumbList");
    expect(JSON.stringify(crumbs)).toContain(
      '"item":"https://example.com/guides/guides"'
    );
    expect(JSON.stringify(crumbs)).toContain(
      '"item":"https://example.com/guides/guides/setup"'
    );
  });
});

describe("localized content links under a base named like a locale", () => {
  it("re-mounts the base after moving the link into the locale", () => {
    const i18n = {
      defaultLocale: "en",
      hideDefaultLocalePrefix: true,
      locales: [{ code: "en" }, { code: "ja" }],
    };
    // Rendered under `deployment.base: "/ja"`, the English link `/guide`
    // arrives as `/ja/guide`; its Japanese copy is served at `/ja/ja/guide`.
    expect(
      localizeHref("/ja/guide#top", {
        basePath: "",
        deployBase: "/ja",
        i18n,
        locale: "ja",
        routes: new Set(["/guide", "/ja/guide"]),
      })
    ).toBe("/ja/ja/guide#top");
  });
});

describe("root-relative file links and images in the agent Markdown", () => {
  const files = {
    "blume.config.ts":
      'export default { basePath: "/docs", deployment: { base: "/sub" } };',
    "docs/guides/install.md": page("Install"),
    "docs/links.md": page("Links"),
    "docs/releases/v1.2.md": page("v1.2"),
  };

  it("give public files and images the deployment base alone, as the HTML does", async () => {
    const project = await scanFixture(files);
    const rewrite = relativeLinkRewriter(project);
    const at = { route: "/docs/links" };
    // A public file (no page at its path) gains the deployment base only.
    expect(rewrite("[spec](/files/spec.pdf#p2)", at)).toBe(
      "[spec](/sub/files/spec.pdf#p2)"
    );
    // A dotted page route is still a page: the full stack.
    expect(rewrite("[notes](/releases/v1.2)", at)).toBe(
      "[notes](/sub/docs/releases/v1.2)"
    );
    // A root-relative image is a file too; a relative one is left to the
    // content-asset rewrite, and an already-based image isn't doubled.
    expect(rewrite("![logo](/logo.png)", at)).toBe("![logo](/sub/logo.png)");
    expect(rewrite("![shot](./shot.png)", at)).toBe("![shot](./shot.png)");
    expect(rewrite("![logo](/sub/logo.png)", at)).toBe(
      "![logo](/sub/logo.png)"
    );
    // A reference definition follows the link rule.
    expect(rewrite("[spec]: /files/spec.pdf", at)).toBe(
      "[spec]: /sub/files/spec.pdf"
    );
  });
});
