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
  askProviderWarnings,
  buildRuntimeData,
  collectStaged,
  detectNeedsReact,
  detectUsesMath,
  diagnosticWarning,
  ensureDepsLink,
  generateRuntime,
  pruneOrphans,
  reactCompilerWarnings,
  resolveReactCompiler,
  sameRealDir,
  searchProviderWarnings,
} from "../src/astro/generate.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";
import type { Diagnostic } from "../src/core/types.ts";

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

  it("rewrites a staged note's colocated image to its served URL", async () => {
    const root = await writeProject({
      "blume.config.ts": `export default {
  content: { sources: [{ type: "obsidian", vault: "vault" }] },
};
`,
      "vault/Guide.md": "# Guide\n\n![chart](./chart.png)\n",
      "vault/chart.png": "png-bytes",
    });
    const project = await scanProject(root);
    const staged = collectStaged(project);
    // The body materializes into `.blume/content`, where `./chart.png` does
    // not exist — the reference must point at the served original instead.
    expect(staged.get("obsidian/Guide.md")).toContain(
      "![chart](/blume-assets/content/vault/chart.png)"
    );
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
    expect(data.config.search.popular).toStrictEqual([]);
    expect(data.config.favicon.href.startsWith("data:image/png")).toBe(true);
    expect(data.navigationByLocale).toEqual({});
    expect(data.uiByLocale).toEqual({});
    expect(data.feeds).toEqual([]);
    const home = data.routes.find(
      (route: { editUrl: string | null; path: string }) => route.path === "/"
    );
    expect(home.editUrl).toBeNull();
  });

  it("serializes the discovery flags for the per-page head links", async () => {
    const project = await scanProject(
      await writeProject({ "docs/index.md": "# Home\n" })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.discovery).toStrictEqual({
      agentReadability: true,
      llmsTxt: true,
      sitemap: false,
    });
  });

  it("serializes the JSON-LD identity, null when neither node is configured", async () => {
    const plain = JSON.parse(
      buildRuntimeData(
        await scanProject(await writeProject({ "docs/index.md": "# Home\n" }))
      )
    );
    expect(plain.config.identity).toBeNull();

    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  seo: {
    organization: { email: "hello@example.com", logo: "/logo.svg" },
    software: { license: "MIT", price: 0 },
  },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.identity).toStrictEqual({
      organization: {
        contactType: "customer support",
        email: "hello@example.com",
        logo: "/logo.svg",
        sameAs: [],
      },
      software: {
        applicationCategory: "DeveloperApplication",
        license: "MIT",
        price: 0,
        priceCurrency: "USD",
        sameAs: [],
      },
    });
  });

  it("flags the sitemap for the 404 page only when a site makes one possible", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  deployment: { site: "https://docs.example.com" },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.discovery.sitemap).toBe(true);
  });

  it("carries discovery opt-outs into runtime data", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  ai: { llmsTxt: false },
  seo: { agentReadability: false },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.discovery).toStrictEqual({
      agentReadability: false,
      llmsTxt: false,
      sitemap: false,
    });
  });

  it("serializes dateFormat, defaulting to the long style", async () => {
    const project = await scanProject(
      await writeProject({ "docs/index.md": "# Home\n" })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.dateFormat).toStrictEqual({ dateStyle: "long" });
  });

  it("carries a configured dateFormat into runtime data", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  dateFormat: { day: "2-digit", month: "short", timeZone: "Australia/Sydney", year: "numeric" },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.dateFormat).toStrictEqual({
      day: "2-digit",
      month: "short",
      timeZone: "Australia/Sydney",
      year: "numeric",
    });
  });

  it("resolves search.popular into runtime data", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  search: {
    popular: [
      { href: "/guides/start", icon: "rocket", label: "Start" },
      { href: "https://example.com", label: "Blog" },
    ],
  },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.search.popular).toStrictEqual([
      { icon: "rocket", label: "Start", route: "/guides/start" },
      { label: "Blog", route: "https://example.com" },
    ]);
  });

  it("bases search.popular routes under basePath", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  basePath: "/docs",
  search: {
    popular: [
      { href: "/guides/start", label: "Start" },
      { href: "/docs/guides/hand-written", label: "Hand written" },
      { href: "https://example.com", label: "Blog" },
    ],
  },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    // Curated hrefs are authored root-relative, so they gain the base — the
    // sidebar fallback's routes are already based. An author-written base is
    // not doubled, and external URLs pass through.
    expect(data.config.search.popular).toStrictEqual([
      { label: "Start", route: "/docs/guides/start" },
      { label: "Hand written", route: "/docs/guides/hand-written" },
      { label: "Blog", route: "https://example.com" },
    ]);
  });

  it("omits edit urls for pages sourced outside the project root", async () => {
    const parent = await writeProject({
      "site/blume.config.ts": `export default {
  github: { owner: "acme", repo: "docs" },
  content: {
    sources: [
      { type: "filesystem", root: "docs" },
      { type: "obsidian", vault: "../vault" },
    ],
  },
};
`,
      "site/docs/index.md": "# Home\n",
      "vault/Note.md": "# Note\n",
    });
    const project = await scanProject(join(parent, "site"));
    const data = JSON.parse(buildRuntimeData(project));
    const home = data.routes.find(
      (route: { path: string }) => route.path === "/"
    );
    const note = data.routes.find(
      (route: { path: string }) => route.path === "/note"
    );
    expect(home.editUrl).toBe(
      "https://github.com/acme/docs/edit/main/docs/index.md"
    );
    // An out-of-tree vault has no in-repo path to edit; a `../`-laden one
    // would fabricate a GitHub 404.
    expect(note.editUrl).toBeNull();
  });

  it("resolves edit urls for a monorepo source above the project dir", async () => {
    const parent = await writeProject({
      "outside/Far.md": "# Far\n",
      "repo/apps/site/blume.config.ts": `export default {
  github: { owner: "acme", repo: "docs", dir: "apps/site" },
  content: {
    sources: [
      { type: "filesystem", root: "docs" },
      { type: "obsidian", vault: "../../notes" },
      { type: "obsidian", vault: "../../../outside", prefix: "out" },
    ],
  },
};
`,
      "repo/apps/site/docs/index.md": "# Home\n",
      "repo/notes/Note.md": "# Note\n",
    });
    const project = await scanProject(join(parent, "repo", "apps", "site"));
    const data = JSON.parse(buildRuntimeData(project));
    const editUrl = (path: string): string | null =>
      data.routes.find((route: { path: string }) => route.path === path)
        .editUrl;
    // `github.dir` places the project inside the repo, so a vault beside the
    // app resolves to an in-repo path; one above the repo root still has
    // nothing to edit.
    expect(editUrl("/")).toBe(
      "https://github.com/acme/docs/edit/main/apps/site/docs/index.md"
    );
    expect(editUrl("/note")).toBe(
      "https://github.com/acme/docs/edit/main/notes/Note.md"
    );
    expect(editUrl("/out/far")).toBeNull();
  });

  it("keeps edit urls when github.dir is written with a leading slash", async () => {
    const root = await writeProject({
      "blume.config.ts": `export default {
  github: { owner: "acme", repo: "docs", dir: "/apps/site/" },
};
`,
      "docs/index.md": "# Home\n",
    });
    const project = await scanProject(root);
    const data = JSON.parse(buildRuntimeData(project));
    const home = data.routes.find(
      (route: { path: string }) => route.path === "/"
    );
    // `dir` is a bare string in the schema. Reading `/apps/site` as absolute
    // would drop the link from every page of a site that has always written
    // it that way, with no diagnostic; the edge slashes are trimmed instead.
    expect(home.editUrl).toBe(
      "https://github.com/acme/docs/edit/main/apps/site/docs/index.md"
    );
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
    expect(data.config.og.logo).toContain('id="brand"');
  });

  it("resolves custom Open Graph branding", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  seo: {
    og: {
      logo: "/og-logo.svg",
      palette: {
        accent: "#ff5410",
        background: "#1d1d1d",
        border: "#323232",
        foreground: "#fff6f2",
        muted: "#a6a19f",
      },
    },
  },
};
`,
        "docs/index.md": "# Home\n",
        "public/og-logo.svg": '<svg id="og-brand"></svg>',
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.logo).toContain('id="og-brand"');
    expect(data.config.og.palette).toEqual({
      accent: "#ff5410",
      background: "#1d1d1d",
      border: "#323232",
      foreground: "#fff6f2",
      muted: "#a6a19f",
    });
  });

  it("ignores a non-SVG Open Graph logo", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts":
          'export default { seo: { og: { logo: "/logo.png" } } };\n',
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.logo).toBeUndefined();
  });

  it("keeps Open Graph fonts out of the runtime data", async () => {
    // Card fonts can carry absolute build-machine paths and the runtime data
    // is serialized into every page's client payload — fonts are baked into
    // the generated OG endpoint instead (see the templates tests).
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  seo: { og: { fonts: ["Noto Sans JP"] } },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.fonts).toBeUndefined();
  });

  it("includes the deployment base in the OG footer site text", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  deployment: { site: "https://torn4dom4n.github.io", base: "/notes" },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    // A GitHub Pages project site lives under the base; the bare host is the
    // platform's shared apex, not this site (#139).
    expect(data.config.og.site).toBe("torn4dom4n.github.io/notes");
  });

  it("uses the bare host as the OG footer site text without a base", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  deployment: { site: "https://docs.acme.com" },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.site).toBe("docs.acme.com");
  });

  it("omits the OG footer site text without a site URL", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": "export default {};\n",
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.site).toBeUndefined();
  });

  it("prefers seo.og.site and seo.og.description overrides", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  deployment: { site: "https://user.github.io", base: "/notes" },
  description: "Site description",
  seo: { og: { site: "example.com/docs", description: "Card subtitle" } },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.site).toBe("example.com/docs");
    expect(data.config.og.description).toBe("Card subtitle");
  });

  it("hides OG card layers set to false", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  deployment: { site: "https://docs.acme.com" },
  description: "Site description",
  logo: "/logo.svg",
  seo: { og: { description: false, logo: false, site: false } },
};
`,
        "docs/index.md": "# Home\n",
        "public/logo.svg": '<svg id="brand"></svg>',
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.site).toBeUndefined();
    expect(data.config.og.description).toBeUndefined();
    // `false` (not undefined) — the card must not fall back to the initial tile.
    expect(data.config.og.logo).toBe(false);
  });

  it("defaults the OG subtitle to the site description", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": 'export default { description: "The docs." };\n',
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.og.description).toBe("The docs.");
  });

  it("records whether the config set theme.fonts itself", async () => {
    const configured = await scanProject(
      await writeProject({
        "blume.config.ts":
          'export default { theme: { fonts: { body: "geist" } } };\n',
        "docs/index.md": "# Home\n",
      })
    );
    expect(configured.themeFontsConfigured).toBeTrue();

    const defaulted = await scanProject(
      await writeProject({
        "blume.config.ts": 'export default { theme: { accent: "green" } };\n',
        "docs/index.md": "# Home\n",
      })
    );
    expect(defaulted.themeFontsConfigured).toBeFalse();
  });

  it("reserves dimensions for per-mode SVG logos", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  logo: { image: { dark: "/dark.svg", light: "/light.svg" } },
};
`,
        "docs/index.md": "# Home\n",
        "public/dark.svg": '<svg viewBox="0 0 608 96"></svg>',
        "public/light.svg": '<svg height="191" width="1214"></svg>',
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.logo.dimensions).toEqual({
      dark: { height: 96, width: 608 },
      light: { height: 191, width: 1214 },
    });
  });

  it("omits dimensions for SVG logos that carry no usable size", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  logo: { image: { dark: "/dark.svg", light: "/light.svg" } },
};
`,
        "docs/index.md": "# Home\n",
        // Legal but unmeasurable: comma-only viewBox parses to no width.
        "public/dark.svg": '<svg viewBox="0,0,24,24"></svg>',
        // No size attributes at all: image-size throws instead of measuring.
        "public/light.svg": "<svg><path /></svg>",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.logo.dimensions).toBeUndefined();
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

  it("pairs a public dark favicon with the light one", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "public/favicon-dark.svg": "<svg></svg>",
        "public/favicon.svg": "<svg></svg>",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.favicon).toEqual({
      dark: { href: "/favicon-dark.svg", type: "image/svg+xml" },
      href: "/favicon.svg",
      type: "image/svg+xml",
    });
  });

  it("ignores a dark file that is not a sibling of the resolved icon", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "public/favicon-dark.png": "FAKEPNG",
        "public/icon.svg": "<svg></svg>",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.favicon).toEqual({
      href: "/icon.svg",
      type: "image/svg+xml",
    });
  });

  it("pairs a root dark favicon sibling as inline data uris", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "icon-dark.png": "FAKEDARKPNG",
        "icon.png": "FAKEPNG",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.favicon.href.startsWith("data:image/png;base64,")).toBe(
      true
    );
    expect(
      data.config.favicon.dark.href.startsWith("data:image/png;base64,")
    ).toBe(true);
    expect(data.config.favicon.dark.href).not.toBe(data.config.favicon.href);
  });

  it("uses a dark-only favicon for both schemes", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "public/icon-dark.svg": "<svg></svg>",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.favicon).toEqual({
      href: "/icon-dark.svg",
      type: "image/svg+xml",
    });
  });

  it("emits no dark variant when the project ships only a light icon", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
        "public/icon.svg": "<svg></svg>",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.favicon.dark).toBeUndefined();
  });

  it("falls back to the bundled light/dark favicon pair", async () => {
    const project = await scanProject(
      await writeProject({
        "docs/index.md": "# Home\n",
      })
    );
    const data = JSON.parse(buildRuntimeData(project));
    expect(data.config.favicon.href.startsWith("data:image/png;base64,")).toBe(
      true
    );
    expect(
      data.config.favicon.dark.href.startsWith("data:image/png;base64,")
    ).toBe(true);
    expect(data.config.favicon.dark.href).not.toBe(data.config.favicon.href);
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

const KITCHEN_SINK = {
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
  it("bridges configured integrations without serializing config source", async () => {
    const root = await writeProject({
      "blume.config.ts": `
        const secret = "must-not-leak";
        export default {
          integrations: [{ hooks: {}, name: "probe-" + secret.length }],
        };
      `,
      "docs/index.md": "# Home\n",
    });
    const project = await scanProject(root);
    await generateRuntime(project);
    const generated = await readFile(
      join(project.context.outDir, "astro.config.mjs"),
      "utf-8"
    );

    expect(generated).toContain("createModuleLoader");
    expect(generated).toContain("...(blumeConfig?.integrations ?? [])");
    expect(generated).toContain('"../blume.config.ts"');
    expect(generated).toMatch(/Blume config source SHA-256: [a-f0-9]{64}/u);
    expect(generated).not.toContain("must-not-leak");
  });

  it("writes the include graph for dev-server partial invalidation", async () => {
    const root = await writeProject({
      "docs/_snippets/shared.mdx": "## Shared\n",
      "docs/a.mdx": "# A\n\n<include>./_snippets/shared.mdx</include>\n",
      "docs/b.mdx": "# B\n\n<include>./_snippets/shared.mdx</include>\n",
      "docs/index.md": "# Home\n",
    });
    const project = await scanProject(root);
    await generateRuntime(project);
    // SAFETY: the file under test was just written by `generateRuntime`,
    // which serializes exactly this shape.
    const graph = JSON.parse(
      await readFile(
        join(project.context.outDir, "src", "generated", "includes.json"),
        "utf-8"
      )
    ) as Record<string, string[]>;
    const partial = join(root, "docs", "_snippets", "shared.mdx");
    expect(graph[partial]?.toSorted()).toEqual([
      join(root, "docs", "a.mdx"),
      join(root, "docs", "b.mdx"),
    ]);
    // The generated config wires the HMR plugin at that graph path.
    const config = await readFile(
      join(project.context.outDir, "astro.config.mjs"),
      "utf-8"
    );
    expect(config).toContain("includeHmrPlugin(");
    expect(config).toContain("includes.json");
  });

  it("rewrites generated config when integration source changes", async () => {
    const root = await writeProject({
      "blume.config.ts": `export default {
        integrations: [{ hooks: {}, name: "first" }],
      };\n`,
      "docs/index.md": "# Home\n",
    });
    const configPath = join(root, "blume.config.ts");
    const firstProject = await scanProject(root);
    await generateRuntime(firstProject);
    const generatedPath = join(firstProject.context.outDir, "astro.config.mjs");
    const first = await readFile(generatedPath, "utf-8");

    await writeFile(
      configPath,
      `export default {
        integrations: [{ hooks: {}, name: "second" }],
      };\n`
    );
    const secondProject = await scanProject(root);
    const result = await generateRuntime(secondProject);
    const second = await readFile(generatedPath, "utf-8");

    expect(result.structuralChange).toBe(true);
    expect(second).not.toBe(first);
    expect(second).not.toContain('name: "second"');
    const hashPattern = /Blume config source SHA-256: (?<hash>[a-f0-9]{64})/u;
    const firstHash = first.match(hashPattern)?.groups?.hash;
    const secondHash = second.match(hashPattern)?.groups?.hash;
    expect(secondHash).not.toBe(firstHash);
  });

  it("bakes theme-derived fonts into the OG endpoint", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  seo: { og: { enabled: true } },
  theme: { fonts: { display: "geist" } },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    await generateRuntime(project);
    const endpoint = await readFile(
      join(project.context.outDir, "src", "pages", "og", "[...slug].png.ts"),
      "utf-8"
    );
    expect(endpoint).toContain('"name":"Geist"');
    // The untouched body default derives too, so the card matches the site.
    expect(endpoint).toContain('"name":"Inter"');
    expect(endpoint).toContain('{"title":"Geist","body":"Inter"}');
  });

  it("fails generation when a configured local font file is missing", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": `export default {
  theme: {
    fonts: {
      body: { name: "Ghost", variants: [{ src: "./fonts/ghost.woff2" }] },
    },
  },
};
`,
        "docs/index.md": "# Home\n",
      })
    );
    expect(generateRuntime(project)).rejects.toThrow(/ghost\.woff2/u);
  });

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
    // Normal layout: the watcher must see `.astro/data-store.json` — Astro's
    // only dev-time content invalidation trigger, without which `.md` edits
    // serve stale HTML — so no cache-dir ignore is emitted.
    expect(astroConfig).not.toContain(".astro/**");

    // The default 404 renders through PageLayout and is kept out of search.
    const notFound = await readFile(join(out, "src/pages/404.astro"), "utf-8");
    expect(notFound).toContain("PageLayout");
    expect(notFound).toContain("export const prerender = true;");
    expect(notFound).toContain("noindex={true}");
  });

  // A migrated (`.`-rooted) project's docs collection contains `.blume/`, but
  // Astro's content watcher honors the collection's `!.blume/**` negation, so
  // no `server.watch.ignored` escape hatch is emitted — `.md` body edits keep
  // hot-reloading instead of needing a dev-server restart.
  it("leaves the dev watcher on Astro's cache dir for root-rooted content", async () => {
    const project = await scanProject(
      await writeProject({
        "blume.config.ts": 'export default { content: { root: "." } };\n',
        "index.md": "# Home\n",
      })
    );
    await generateRuntime(project);
    const astroConfig = await readFile(
      join(project.context.outDir, "astro.config.mjs"),
      "utf-8"
    );
    expect(astroConfig).not.toContain(".astro/**");
    const contentConfig = await readFile(
      join(project.context.outDir, "src/content.config.ts"),
      "utf-8"
    );
    expect(contentConfig).toContain('"!.blume/**"');
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
    // The direct Astro package lookup yields null and `readPkgVersion` takes its
    // null-path guard — the diagnostic falls back to its version-less form.
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

describe("resolveReactCompiler", () => {
  // SAFETY: resolveReactCompiler reads only `react.compiler`, so this partial
  // config is all it needs.
  const compilerOn = { react: { compiler: true } } as ResolvedConfig;
  // SAFETY: same partial-config shortcut as `compilerOn`.
  const compilerOff = { react: { compiler: false } } as ResolvedConfig;

  it("resolves Blume's shipped babel plugin as an absolute path", () => {
    expect(resolveReactCompiler(compilerOn, true)).toContain(
      "babel-plugin-react-compiler"
    );
  });

  it("returns null when React isn't needed or the compiler is off", () => {
    expect(resolveReactCompiler(compilerOn, false)).toBeNull();
    expect(resolveReactCompiler(compilerOff, true)).toBeNull();
  });

  it("returns null when the plugin doesn't resolve from the package dir", () => {
    // An empty temp dir has no node_modules anywhere up its ancestor chain
    // that could hold the plugin, so resolution throws and the helper
    // degrades to null instead of failing the build.
    expect(resolveReactCompiler(compilerOn, true, srcDir)).toBeNull();
  });
});

describe("reactCompilerWarnings", () => {
  // SAFETY: reactCompilerWarnings reads only `react.compiler`, so this partial
  // config is all it needs.
  const compilerOn = { react: { compiler: true } } as ResolvedConfig;

  it("warns when the compiler was requested but its plugin is missing", () => {
    const warnings = reactCompilerWarnings(compilerOn, true, null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("babel-plugin-react-compiler");
    expect(warnings[0]).toContain("react: { compiler: false }");
  });

  it("stays quiet when the plugin resolved or React isn't in play", () => {
    expect(reactCompilerWarnings(compilerOn, true, "/some/path")).toEqual([]);
    expect(reactCompilerWarnings(compilerOn, false, null)).toEqual([]);
  });
});

describe("sameRealDir", () => {
  it("matches two spellings of one physical directory", () => {
    expect(sameRealDir(srcDir, join(srcDir, ".", "."))).toBe(true);
  });

  it("is false for distinct directories", () => {
    expect(sameRealDir(srcDir, tmpdir())).toBe(false);
  });

  it("is false when a path doesn't exist", () => {
    expect(sameRealDir(join(srcDir, "missing"), srcDir)).toBe(false);
  });
});

describe("diagnosticWarning", () => {
  const base: Diagnostic = {
    code: "BLUME_TEST",
    message: "Something looks off.",
    severity: "warning",
  };

  it("appends the suggestion when one exists", () => {
    expect(diagnosticWarning({ ...base, suggestion: "Fix it." })).toBe(
      "Something looks off. Fix it."
    );
  });

  it("returns the bare message otherwise", () => {
    expect(diagnosticWarning(base)).toBe("Something looks off.");
  });
});

// A parsed (schema-defaulted) `ai.ask` block, the shape askProviderWarnings
// receives from the resolved config.
const parsedAsk = (ask: {
  baseUrl?: string;
  enabled: boolean;
  endpoint?: string;
  provider?: string;
}) => blumeConfigSchema.parse({ ai: { ask } }).ai.ask;

describe("generateRuntime preflight and write failures", () => {
  it("warns when the search provider's SDK isn't installed anywhere", () => {
    // An empty temp dir stands in for both the project root and the Blume
    // package, so the provider's SDK resolves from neither.
    const warnings = searchProviderWarnings("flexsearch", srcDir, srcDir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Search provider "flexsearch"');
    expect(warnings[0]).toContain('needs "flexsearch"');
  });

  it("stays quiet when the provider's SDK ships with Blume", () => {
    expect(searchProviderWarnings("orama", srcDir)).toEqual([]);
  });

  it("warns when the Ask AI backend's provider SDK isn't installed anywhere", () => {
    const ask = parsedAsk({ enabled: true, provider: "openrouter" });
    const warnings = askProviderWarnings(ask, srcDir, srcDir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ask AI provider "openrouter"');
    expect(warnings[0]).toContain(
      "Run `npm install @openrouter/ai-sdk-provider`"
    );
  });

  it("stays quiet for the gateway backend, an external endpoint, and disabled Ask AI", () => {
    // Gateway needs only the core `ai` package, which ships with Blume.
    expect(
      askProviderWarnings(parsedAsk({ enabled: true }), srcDir, srcDir)
    ).toEqual([]);
    // An external endpoint means the provider route is never generated.
    expect(
      askProviderWarnings(
        parsedAsk({
          enabled: true,
          endpoint: "https://api.example.com/ask",
          provider: "openrouter",
        }),
        srcDir,
        srcDir
      )
    ).toEqual([]);
    expect(askProviderWarnings(undefined, srcDir, srcDir)).toEqual([]);
  });

  it("stays quiet when the Ask AI provider SDK is resolvable", () => {
    const ask = parsedAsk({
      baseUrl: "https://api.example.com/v1",
      enabled: true,
      provider: "openai-compatible",
    });
    // The monorepo root resolves the workspace-installed SDK.
    expect(askProviderWarnings(ask, srcDir)).toEqual([]);
  });

  it("cleans up the temp file and rethrows when the atomic rename fails", async () => {
    const project = await scanProject(
      await writeProject({ "docs/index.md": "# Home\n" })
    );
    const out = project.context.outDir;
    // A directory squatting on a generated file path: `rename` can't replace a
    // directory with a file, so the atomic write fails after the temp file is
    // written — and must remove it on the way out.
    await mkdir(join(out, "astro.config.mjs"), { recursive: true });

    await expect(generateRuntime(project)).rejects.toThrow();
    expect(existsSync(join(out, `astro.config.mjs.${process.pid}.tmp`))).toBe(
      false
    );
  });
});
