import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { dirname, join, normalize } from "pathe";

import {
  buildRuntimeData,
  collectStaged,
  detectNeedsReact,
  detectUsesMath,
  ensureDepsLink,
  generateRuntime,
  pruneOrphans,
} from "../src/astro/generate.ts";
import { scanProject } from "../src/core/project-graph.ts";

let srcDir: string;

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), "blume-prune-"));
});

afterEach(async () => {
  await rm(srcDir, { force: true, recursive: true });
});

// Create a file under srcDir and return its normalized absolute path, matching
// the shape the generator records in its `written` set.
const touch = async (rel: string): Promise<string> => {
  const path = join(srcDir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x", "utf-8");
  return normalize(path);
};

describe("pruneOrphans", () => {
  it("deletes files the pass didn't write and keeps the rest", async () => {
    const keepPage = await touch("pages/[...slug].astro");
    const keepData = await touch("generated/data.json");
    // A server-rendered endpoint left behind after a feature was switched off.
    await touch("pages/api/ask.ts");

    await pruneOrphans(srcDir, new Set([keepPage, keepData]));

    expect(existsSync(join(srcDir, "pages", "[...slug].astro"))).toBe(true);
    expect(existsSync(join(srcDir, "generated", "data.json"))).toBe(true);
    expect(existsSync(join(srcDir, "pages", "api", "ask.ts"))).toBe(false);
  });

  it("leaves every file when all were written", async () => {
    const env = await touch("env.d.ts");
    const page = await touch("pages/index.astro");

    await pruneOrphans(srcDir, new Set([env, page]));

    expect(existsSync(join(srcDir, "env.d.ts"))).toBe(true);
    expect(existsSync(join(srcDir, "pages", "index.astro"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared fixtures: write a temp content project, then scan it into a
// BlumeProject. Temp dirs start with `blume-` and are cleaned up afterAll.
// ---------------------------------------------------------------------------

const projectDirs: string[] = [];

/** The Blume package root, used to nest a project beside its node_modules. */
const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

afterAll(async () => {
  await Promise.all(
    projectDirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const writeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-gen-"));
  projectDirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    })
  );
  return root;
};

const stagedConfig = (body: string): string => `export default {
  content: {
    sources: [
      { root: "docs", type: "filesystem" },
      {
        source: {
          load: () =>
            Promise.resolve({
              diagnostics: [],
              entries: [
                {
                  body: { format: "mdx", text: ${JSON.stringify(body)} },
                  data: { title: "Guide" },
                  raw: ${JSON.stringify(`---\ntitle: Guide\n---\n${body}`)},
                  ref: "guide.mdx",
                },
              ],
            }),
          name: "remote",
          staged: true,
        },
        type: "custom",
      },
    ],
  },
};
`;

const scanStaged = async (body = "# Guide\n") =>
  await scanProject(
    await writeProject({
      "blume.config.ts": stagedConfig(body),
      "docs/index.md": "# Home\n",
    })
  );

describe("detectNeedsReact", () => {
  it("is false for a markdown-only project", async () => {
    const root = await writeProject({ "docs/index.md": "# Home\n" });
    expect(await detectNeedsReact(root)).toBe(false);
  });

  it("is true when the project has a tsx/jsx file", async () => {
    const root = await writeProject({
      "docs/index.md": "# Home\n",
      "islands/Counter.tsx": "export default () => null;\n",
    });
    expect(await detectNeedsReact(root)).toBe(true);
  });
});

describe("detectUsesMath", () => {
  it("is false for a project with no math anywhere", async () => {
    const root = await writeProject({ "docs/index.md": "# Home\n" });
    expect(await detectUsesMath(root)).toBe(false);
  });

  it("sees block math in a plain .md file", async () => {
    const root = await writeProject({
      "docs/index.md": "# Home\n\n$$\na^2 + b^2 = c^2\n$$\n",
    });
    expect(await detectUsesMath(root)).toBe(true);
  });

  it("sees an explicit <Math> tag with no $$ anywhere", async () => {
    const root = await writeProject({
      "docs/index.mdx": '# Home\n\n<Math code="a^2" />\n',
    });
    expect(await detectUsesMath(root)).toBe(true);
  });

  it("sees math in staged source bodies the filesystem never holds", async () => {
    const root = await writeProject({ "docs/index.md": "# Home\n" });
    expect(await detectUsesMath(root, ["# Guide\n\n$$\nE = mc^2\n$$\n"])).toBe(
      true
    );
    expect(await detectUsesMath(root, ["# Guide\n"])).toBe(false);
  });
});

describe("collectStaged", () => {
  it("collects staged page bodies keyed by entry id", async () => {
    const project = await scanStaged();
    const staged = collectStaged(project);
    expect(staged.get("remote/guide.mdx")).toContain("# Guide");
  });

  it("returns an empty map when no source is staged", async () => {
    const project = await scanProject(
      await writeProject({ "docs/index.md": "# Home\n" })
    );
    expect(collectStaged(project).size).toBe(0);
  });
});

describe("buildRuntimeData", () => {
  it("serializes a minimal project with feature defaults off", async () => {
    const project = await scanProject(
      await writeProject({ "docs/index.md": "# Home\n" })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.title).toBe("Documentation");
    expect(data.config.i18n).toBeNull();
    expect(data.config.repoUrl).toBeNull();
    expect(data.config.banner).toBeNull();
    expect(data.config.logo).toBeNull();
    expect(data.config.mcp).toBeNull();
    expect(data.config.og.enabled).toBe(false);
    expect(data.config.search.provider).toBe("orama");
    expect(data.config.favicon.href.startsWith("data:image/png")).toBe(true);
    expect(data.navigationByLocale).toEqual({});
    expect(data.uiByLocale).toEqual({});
    expect(data.feeds).toEqual([]);
    const home = data.routes.find(
      (route: { editUrl: string | null; path: string }) => route.path === "/"
    );
    expect(home.editUrl).toBeNull();
  });

  it("resolves github edit urls, repo url, banner, logo, mcp and og", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  banner: { content: "Hello", dismissible: true, id: "promo", link: { href: "/x", text: "Go" } },
  deployment: { site: "https://example.com" },
  github: { owner: "acme", repo: "docs" },
  ai: { mcp: { enabled: true, name: "Docs MCP" } },
  logo: { href: "/home", image: { alt: "Logo", dark: "/dark.png", light: "/light.png" } },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.repoUrl).toBe("https://github.com/acme/docs");
    const home = data.routes.find(
      (route: { editUrl: string | null; path: string }) => route.path === "/"
    );
    expect(home.editUrl).toBe(
      "https://github.com/acme/docs/edit/main/docs/index.md"
    );
    expect(data.config.banner).toEqual({
      content: "Hello",
      dismissible: true,
      key: "promo",
      link: { href: "/x", text: "Go" },
    });
    expect(data.config.logo).toEqual({
      alt: "Logo",
      dark: "/dark.png",
      href: "/home",
      light: "/light.png",
    });
    expect(data.config.mcp).toEqual({ name: "Docs MCP", route: "/mcp" });
    expect(data.config.og.enabled).toBe(true);
    expect(data.config.site).toBe("https://example.com");
  });

  it("threads per-locale ui and navigation under i18n", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  i18n: {
    defaultLocale: "en",
    fallbackLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "fr", dir: "ltr", label: "Français" },
    ],
  },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.i18n.defaultLocale).toBe("en");
    expect(data.config.i18n.fallbackLocale).toBe("en");
    expect(
      data.config.i18n.locales.map((locale: { code: string }) => locale.code)
    ).toEqual(["en", "fr"]);
    expect(Object.keys(data.uiByLocale)).toEqual(["en", "fr"]);
    expect(Object.keys(data.navigationByLocale)).toEqual(["en", "fr"]);
  });

  it("inlines a single-file SVG logo", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": 'export default { logo: "/logo.svg" };\n',
        "docs/index.md": "# Home\n",
        "public/logo.svg": '<svg id="brand"></svg>',
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.logo.svg).toContain('id="brand"');
    expect(data.config.logo.href).toBe("/");
  });

  it("falls back to an <img> logo when the SVG file is absent", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": 'export default { logo: "/missing.svg" };\n',
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.logo.svg).toBeUndefined();
    expect(data.config.logo.light).toBe("/missing.svg");
  });

  it("carries an image mark alongside explicit wordmark text", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts":
          'export default { logo: { image: "/missing.svg", text: "Acme Docs" } };\n',
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.logo.light).toBe("/missing.svg");
    expect(data.config.logo.text).toBe("Acme Docs");
  });

  it("keeps an empty wordmark (image-only) distinct from an omitted one", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts":
          'export default { logo: { image: "/missing.svg", text: "" } };\n',
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    // Explicit "" is preserved (the brand renders the mark alone); an omitted
    // `text` would be dropped from the JSON and fall back to the site title.
    expect(data.config.logo.text).toBe("");
  });

  it("supports a text-only logo with no image", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": 'export default { logo: { text: "Acme" } };\n',
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.logo.text).toBe("Acme");
    expect(data.config.logo.light).toBeUndefined();
    expect(data.config.logo.svg).toBeUndefined();
  });

  it("normalizes a string banner and inlines a root favicon", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": 'export default { banner: "Heads up" };\n',
        "docs/index.md": "# Home\n",
        "icon.png": "FAKEPNG",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.banner).toEqual({
      content: "Heads up",
      dismissible: false,
      key: "Heads up",
    });
    expect(data.config.favicon.href.startsWith("data:image/png;base64,")).toBe(
      true
    );
  });

  it("references a public favicon by url", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "public/favicon.svg": "<svg></svg>",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.favicon).toEqual({
      href: "/favicon.svg",
      type: "image/svg+xml",
    });
  });

  it("references a public apple touch icon by url", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "public/apple-icon.png": "FAKEPNG",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.appleIcon).toEqual({
      href: "/apple-icon.png",
      type: "image/png",
    });
  });

  it("maps the apple touch icon mime for jpg files", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "public/apple-icon.jpg": "FAKEJPG",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.appleIcon).toEqual({
      href: "/apple-icon.jpg",
      type: "image/jpeg",
    });
  });

  it("inlines a root apple touch icon as a data uri", async () => {
    const project = await scanProject(
      await writeProject({
        "apple-touch-icon.png": "FAKEPNG",
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(
      data.config.appleIcon.href.startsWith("data:image/png;base64,")
    ).toBe(true);
  });

  it("emits no apple touch icon when the project ships none", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.appleIcon).toBeNull();
    // The favicon is independent and still falls back to the bundled default.
    expect(data.config.favicon.href.startsWith("data:image/png")).toBe(true);
  });
});

const KITCHEN_SINK: Record<string, string> = {
  "blume.config.ts": `export default {
  ai: { ask: { enabled: true }, mcp: { enabled: true } },
  deployment: { site: "https://example.com" },
  export: true,
  github: { dir: "site", owner: "acme", repo: "docs" },
  logo: "/logo.svg",
  openapi: { enabled: true, renderer: "scalar", spec: "./openapi.json" },
  redirects: [{ from: "/old", to: "/new" }],
};
`,
  "docs/blog/post.md":
    "---\ntitle: Post\ntype: blog\ndate: 2024-01-01\n---\n# Post\n",
  "docs/changelog/v1.md":
    "---\ntitle: v1\ntype: changelog\nchangelog:\n  date: 2024-02-01\n---\n# v1\n",
  "docs/index.md": "# Home\n",
  // Block math (`$$…$$`) in .mdx makes detectUsesMath wire in <Math>.
  "docs/math.mdx": "# Math\n\n$$\na^2 + b^2 = c^2\n$$\n",
  "examples/demo.tsx": "export default function Demo() { return null; }\n",
  "islands/Counter.tsx":
    'export const client = "load";\nexport default function Counter() { return null; }\n',
  "openapi.json": JSON.stringify({
    info: { title: "API", version: "1" },
    openapi: "3.0.0",
    paths: {},
  }),
  "pages/extra.astro": "<h1>Extra</h1>\n",
  "public/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  "public/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>',
  "theme.css": ":root {\n  --x: 1;\n}\n",
};

describe("generateRuntime", () => {
  it("writes the full runtime for a feature-rich project", async () => {
    const project = await scanProject(await writeProject(KITCHEN_SINK));
    const out = project.context.outDir;
    const result = await generateRuntime(project);
    const has = (rel: string): boolean => existsSync(join(out, rel));

    // Structural files.
    expect(has("astro.config.mjs")).toBe(true);
    expect(has("package.json")).toBe(true);
    expect(has("tsconfig.json")).toBe(true);
    expect(has("src/env.d.ts")).toBe(true);
    expect(has("src/content.config.ts")).toBe(true);
    expect(has("src/pages/[...slug].astro")).toBe(true);
    expect(has("src/generated/components.ts")).toBe(true);
    expect(has("src/generated/islands.ts")).toBe(true);

    // Feature-gated files.
    expect(has("src/pages/api/ask.ts")).toBe(true);
    expect(has("src/generated/ask-data.json")).toBe(true);
    expect(has("src/pages/og/[...slug].png.ts")).toBe(true);
    expect(has("src/pages/changelog.astro")).toBe(true);
    expect(has("src/pages/404.astro")).toBe(true);
    expect(has("src/pages/blume-search.json.ts")).toBe(true);
    expect(has("src/generated/search.json")).toBe(true);
    expect(has("src/pages/[section]/rss.xml.ts")).toBe(true);
    expect(has("src/generated/rss.json")).toBe(true);
    expect(has("src/pages/mcp.ts")).toBe(true);
    expect(has("src/blume-mcp/discovery.ts")).toBe(true);
    expect(has("src/blume-mcp/server-card.ts")).toBe(true);
    expect(has("src/generated/mcp-data.json")).toBe(true);
    expect(has("src/pages/reference.astro")).toBe(true);
    expect(has("src/generated/openapi.json")).toBe(true);
    expect(has("src/generated/islands/Counter.astro")).toBe(true);
    expect(has("src/generated/examples.ts")).toBe(true);
    expect(has("src/generated/examples/demo.astro")).toBe(true);
    // The isolated preview frame: its Tailwind entry and per-example route.
    expect(has("src/generated/examples.css")).toBe(true);
    expect(has("src/pages/blume-examples/[...path].astro")).toBe(true);
    expect(has("src/generated/data.json")).toBe(true);
    expect(has("blume.manifest.json")).toBe(true);
    // ensureDepsLink symlinked the package's node_modules into .blume.
    expect(has("node_modules")).toBe(true);

    expect(result.structuralChange).toBe(true);
    // Orama (the default provider) ships with Blume, so even though this temp
    // project's root can't resolve `@orama/orama`, the build reaches it through
    // Blume's own deps — the preflight checks there too and stays quiet.
    expect(result.warnings.some((w) => w.includes("@orama/orama"))).toBe(false);

    // The catch-all wires in Math for this project. The Ask AI trigger is the
    // header's, reached through the generated `blume:ask` component, so no page
    // template mentions it.
    const catchAll = await readFile(
      join(out, "src/pages/[...slug].astro"),
      "utf-8"
    );
    expect(catchAll).toContain("Math.astro");
    expect(catchAll).not.toContain("AskAI");

    const ask = await readFile(join(out, "src/generated/Ask.astro"), "utf-8");
    expect(ask).toContain("AskAI.astro");
    const astroConfig = await readFile(join(out, "astro.config.mjs"), "utf-8");
    expect(astroConfig).toContain('"blume:ask"');

    // The default 404 renders through PageLayout and is kept out of search.
    const notFound = await readFile(join(out, "src/pages/404.astro"), "utf-8");
    expect(notFound).toContain("PageLayout");
    expect(notFound).toContain("export const prerender = true;");
    expect(notFound).toContain("noindex={true}");
  });

  it("skips the preview route when there are no examples", async () => {
    const project = await scanProject(
      await writeProject({ "docs/index.md": "# Home\n" })
    );
    const out = project.context.outDir;
    await generateRuntime(project);
    expect(
      existsSync(join(out, "src/pages/blume-examples/[...path].astro"))
    ).toBe(false);
    // The examples sheet is still written so `blume:examples-theme` resolves.
    expect(existsSync(join(out, "src/generated/examples.css"))).toBe(true);
  });

  it("nests the preview route under basePath and inlines examples.css", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  basePath: "/docs",
  examples: { css: "examples/theme.css" },
};
`,
        "docs/index.md": "# Home\n",
        "examples/demo.tsx":
          "export default function Demo() { return null; }\n",
        "examples/theme.css": ":root {\n  --primary: hotpink;\n}\n",
      })
    );
    const out = project.context.outDir;
    const result = await generateRuntime(project);

    expect(
      existsSync(join(out, "src/pages/docs/blume-examples/[...path].astro"))
    ).toBe(true);
    const map = await readFile(join(out, "src/generated/examples.ts"), "utf-8");
    expect(map).toContain('export const examplesBase = "/docs/blume-examples"');
    const sheet = await readFile(
      join(out, "src/generated/examples.css"),
      "utf-8"
    );
    expect(sheet).toContain("--primary: hotpink;");
    expect(result.warnings.some((w) => w.includes("examples.css"))).toBe(false);
  });

  it("warns when the configured examples.css is missing", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  examples: { css: "examples/theme.css" },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const result = await generateRuntime(project);
    expect(
      result.warnings.some((w) =>
        w.includes('examples.css points at "examples/theme.css"')
      )
    ).toBe(true);
  });

  it("skips the default 404 when a custom pages/404.astro owns the route", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "pages/404.astro": "<h1>Gone</h1>\n",
      })
    );
    const out = project.context.outDir;
    await generateRuntime(project);
    // The user's injected `/404` is the only one, so Blume writes no default.
    expect(existsSync(join(out, "src/pages/404.astro"))).toBe(false);
  });

  it("skips the default 404 when a 404.md content page owns the route", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/404.md": "---\ntitle: Gone\n---\n# Gone\n",
        "docs/index.md": "# Home\n",
      })
    );
    const out = project.context.outDir;
    await generateRuntime(project);
    expect(existsSync(join(out, "src/pages/404.astro"))).toBe(false);
  });

  it("rewrites nothing on a second identical pass", async () => {
    const root = await writeProject(KITCHEN_SINK);
    await generateRuntime(await scanProject(root));
    // Second pass: every structural file is byte-identical, so nothing changes
    // and ensureDepsLink takes its already-resolvable early return.
    const second = await generateRuntime(await scanProject(root));
    expect(second.structuralChange).toBe(false);
  });

  it("resolves Astro natively without a node_modules symlink when hoisted", async () => {
    // A project nested under the package resolves Astro from the package's own
    // node_modules, so ensureDepsLink takes its already-resolvable early return
    // and never symlinks dependencies into .blume.
    const root = await mkdtemp(join(PKG_ROOT, "blume-gen-native-"));
    projectDirs.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "index.md"), "# Home\n", "utf-8");
    await generateRuntime(await scanProject(root));
    expect(existsSync(join(root, ".blume", "node_modules"))).toBe(false);
  });

  it("leaves an existing .blume/node_modules untouched", async () => {
    const root = await writeProject({ "docs/index.md": "# Home\n" });
    const out = join(root, ".blume");
    await mkdir(join(out, "node_modules"), { recursive: true });
    await generateRuntime(await scanProject(root));
    expect(existsSync(join(out, "node_modules"))).toBe(true);
  });

  it("skips the MCP server when a content page owns its route", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts":
          "export default { ai: { mcp: { enabled: true } } };\n",
        "docs/index.md": "# Home\n",
        "docs/mcp.md": "# MCP\n",
      })
    );
    const result = await generateRuntime(project);
    expect(
      result.warnings.some((w) =>
        w.includes("already used by a content or custom page")
      )
    ).toBe(true);
    expect(existsSync(join(project.context.outDir, "src/pages/mcp.ts"))).toBe(
      false
    );
  });

  it("skips the MCP server when a custom .astro page owns its route", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts":
          "export default { ai: { mcp: { enabled: true } } };\n",
        "docs/index.md": "# Home\n",
        "pages/mcp.astro": "---\n---\n<h1>Custom MCP page</h1>\n",
      })
    );
    const result = await generateRuntime(project);
    expect(
      result.warnings.some((w) =>
        w.includes("already used by a content or custom page")
      )
    ).toBe(true);
    expect(existsSync(join(project.context.outDir, "src/pages/mcp.ts"))).toBe(
      false
    );
  });

  it("writes the mixedbread proxy endpoint for the server provider", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default { deployment: { output: "server" }, search: { mixedbread: { storeId: "store_7" }, provider: "mixedbread" } };
`,
        "docs/index.md": "# Home\n",
      })
    );
    const out = project.context.outDir;
    await generateRuntime(project);
    expect(existsSync(join(out, "src/pages/api/search.ts"))).toBe(true);
    const client = await readFile(
      join(out, "src/generated/search-client.ts"),
      "utf-8"
    );
    expect(client).toContain("api/search");
    // A server provider ships no static index.
    expect(existsSync(join(out, "src/generated/search.json"))).toBe(false);
  });

  it("warns when Vue/Svelte islands lack their Astro integration", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "islands/Box.svelte": "<div></div>\n",
        "islands/Widget.vue": "<template><div /></template>\n",
      })
    );
    const out = project.context.outDir;
    const result = await generateRuntime(project);
    expect(result.warnings.some((w) => w.includes("@astrojs/vue"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("@astrojs/svelte"))).toBe(
      true
    );
    expect(existsSync(join(out, "src/generated/islands/Widget.astro"))).toBe(
      true
    );
    expect(existsSync(join(out, "src/generated/islands/Box.astro"))).toBe(true);
  });

  it("warns when the netlify adapter package isn't installed", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default { deployment: { adapter: "netlify", output: "server" } };
`,
        "docs/index.md": "# Home\n",
      })
    );
    const result = await generateRuntime(project);
    expect(
      result.warnings.some(
        (w) =>
          w.includes('Deployment adapter "netlify"') &&
          w.includes("@astrojs/netlify")
      )
    ).toBe(true);
  });

  it("warns when the cloudflare adapter package isn't installed", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default { deployment: { adapter: "cloudflare", output: "server" } };
`,
        "docs/index.md": "# Home\n",
      })
    );
    const result = await generateRuntime(project);
    expect(
      result.warnings.some(
        (w) =>
          w.includes('Deployment adapter "cloudflare"') &&
          w.includes("@astrojs/cloudflare")
      )
    ).toBe(true);
  });

  it("stays quiet when the project installed the netlify adapter", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default { deployment: { adapter: "netlify", output: "server" } };
`,
        "docs/index.md": "# Home\n",
        "node_modules/@astrojs/netlify/index.js":
          "export default () => ({});\n",
        "node_modules/@astrojs/netlify/package.json": `{ "main": "index.js", "name": "@astrojs/netlify", "version": "8.0.0" }
`,
      })
    );
    const result = await generateRuntime(project);
    expect(result.warnings.some((w) => w.includes("@astrojs/netlify"))).toBe(
      false
    );
  });

  it("stays quiet for server output with an adapter Blume ships", async () => {
    // Node and Vercel resolve from Blume's own dependencies, so the preflight
    // never flags them.
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default { deployment: { adapter: "node", output: "server" } };
`,
        "docs/index.md": "# Home\n",
      })
    );
    const result = await generateRuntime(project);
    expect(result.warnings.some((w) => w.includes("Deployment adapter"))).toBe(
      false
    );
  });

  it("materializes staged content into .blume/content", async () => {
    const project = await scanStaged();
    const out = project.context.outDir;
    await generateRuntime(project);
    expect(existsSync(join(out, "content/remote/guide.mdx"))).toBe(true);
    const contentConfig = await readFile(
      join(out, "src/content.config.ts"),
      "utf-8"
    );
    expect(contentConfig).toContain("const staged = defineCollection(");
    // Nothing in this project authors math, so the catch-all skips <Math>.
    const catchAll = await readFile(
      join(out, "src/pages/[...slug].astro"),
      "utf-8"
    );
    expect(catchAll).not.toContain("Math.astro");
  });

  it("wires <Math> when only a staged source authors block math", async () => {
    // The staged body never exists under the project root, so the filesystem
    // scan alone would miss it and the generated page map would omit <Math>.
    const project = await scanStaged("# Guide\n\n$$\nE = mc^2\n$$\n");
    const out = project.context.outDir;
    await generateRuntime(project);
    const catchAll = await readFile(
      join(out, "src/pages/[...slug].astro"),
      "utf-8"
    );
    expect(catchAll).toContain("Math.astro");
  });

  it("plans components.ts overrides and surfaces nav + component diagnostics", async () => {
    const project = await scanProject(
      await writeProject({
        // A hydrated island override — statically analyzed, never executed —
        // so `buildComponentSlots` reads and plans a hydration wrapper.
        "Counter.tsx": "export default function Counter() { return null; }\n",
        "blume.config.ts": `export default {
  navigation: {
    tabs: [
      { label: "Docs", path: "/" },
      { label: "Ghost", path: "/ghost" },
    ],
  },
};
`,
        "components.ts": `import Counter from "./Counter.tsx";
export default { islands: { Counter } };
`,
        "docs/index.md": "# Home\n",
        // An unknown `<Fancy>` tag that isn't a built-in, island, or override.
        "docs/page.mdx": "---\ntitle: Page\n---\n\nUse the <Fancy /> widget.\n",
      })
    );
    const out = project.context.outDir;
    const result = await generateRuntime(project);
    // The island override was analyzed and emitted as a per-override wrapper.
    expect(
      existsSync(join(out, "src/generated/component-slots/mdx-Counter.astro"))
    ).toBe(true);
    // A nav tab pointing at a route no page serves is flagged.
    expect(result.warnings.some((w) => w.includes("/ghost"))).toBe(true);
    // The unknown MDX component tag is flagged.
    expect(result.warnings.some((w) => w.includes("<Fancy>"))).toBe(true);
  });
});

describe("ensureDepsLink version-less conflict", () => {
  const conflictDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(
      conflictDirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("degrades to a version-less warning when neither Astro resolves", async () => {
    // A split layout where the `astro` directory holds no package.json, so
    // `resolvedAstroPath` yields null and `readPkgVersion` takes its null-path
    // guard — the diagnostic falls back to its version-less form.
    const dir = await mkdtemp(join(tmpdir(), "blume-conflict-"));
    conflictDirs.push(dir);
    const pkgDir = join(dir, "node_modules", "blume");
    await mkdir(join(pkgDir, "node_modules", "astro"), { recursive: true });
    const outDir = join(dir, ".blume");
    await mkdir(outDir, { recursive: true });

    const warning = await ensureDepsLink(outDir, pkgDir);

    expect(warning).toContain("Astro version conflict");
    expect(warning).toContain("a second copy of Astro");
    expect(warning).toContain("<Blume's astro version>");
  });
});
