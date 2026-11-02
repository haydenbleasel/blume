import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { BlumeError } from "../src/core/diagnostics.ts";
import { scanProject } from "../src/core/project-graph.ts";

const dirs: string[] = [];

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-scan-"));
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

const CONTENT = {
  "docs/bad.md": "---\nnope: 1\n---\n# Bad\n",
  "docs/draft.md": "---\ntitle: Draft\ndraft: true\n---\n# Draft\n",
  "docs/index.md": "# Home\n",
};

const routesOf = (paths: { path: string }[]): string[] =>
  paths.map((route) => route.path);

const syntaxErrors = (project: { diagnostics: { code: string }[] }) =>
  project.diagnostics.filter((d) => d.code === "BLUME_MDX_SYNTAX");

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("scanProject", () => {
  it("runs the full pipeline with zero config, keeping drafts in dev", async () => {
    const project = await scanProject(await makeProject(CONTENT));

    expect(project.mode).toBe("dev");
    expect(project.config.title).toBe("Documentation");
    expect(project.context.contentRoot.endsWith("docs")).toBe(true);
    expect(routesOf(project.manifest.routes)).toStrictEqual(["/", "/draft"]);
  });

  it("drops drafts in build mode", async () => {
    const project = await scanProject(await makeProject(CONTENT), {
      mode: "build",
    });
    expect(project.mode).toBe("build");
    expect(routesOf(project.manifest.routes)).toStrictEqual(["/"]);
  });

  it("keeps drafts in build mode under preview", async () => {
    const project = await scanProject(await makeProject(CONTENT), {
      mode: "build",
      preview: true,
    });
    expect(routesOf(project.manifest.routes)).toStrictEqual(["/", "/draft"]);
  });

  it("threads content.types frontmatter through to page validation", async () => {
    // A dependency-free Standard Schema, so the temp config needs no imports.
    const project = await scanProject(
      await makeProject({
        "blume.config.ts": `const status = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string"
        ? { value }
        : { issues: [{ message: "must be a string" }] },
  },
};
export default { content: { types: { rfc: { frontmatter: { status } } } } };`,
        "docs/guide.md": "---\ntitle: Guide\n---\n# Guide\n",
        "docs/incomplete.md": "---\ntitle: RFC 2\ntype: rfc\n---\n# RFC 2\n",
        "docs/rfc.md":
          "---\ntitle: RFC 1\ntype: rfc\nstatus: enforced\n---\n# RFC 1\n",
      })
    );

    const byRoute = new Map(
      project.graph.pages.map((page) => [page.route, page])
    );
    expect(byRoute.get("/rfc")?.custom).toStrictEqual({ status: "enforced" });
    // The per-type key applies only to `type: rfc` pages, so the plain doc
    // page carries no custom values and the incomplete RFC is rejected.
    expect(byRoute.get("/guide")?.custom).toBeUndefined();
    expect(byRoute.has("/incomplete")).toBe(false);
    expect(project.diagnostics.map((d) => d.code)).toContain(
      "BLUME_FRONTMATTER_INVALID"
    );
  });

  it("aggregates content diagnostics without throwing", async () => {
    const project = await scanProject(await makeProject(CONTENT));
    expect(project.diagnostics.map((d) => d.code)).toContain(
      "BLUME_FRONTMATTER_INVALID"
    );
    // The invalid entry yields no pages — surfaced as a dropped-page count so
    // the CLI can fail (or at least say so) instead of reporting a clean build.
    expect(project.droppedPages).toBe(1);
  });

  it("drops an .mdx page that doesn't parse from a build, and keeps it in dev", async () => {
    // Invalid front matter and MDX together still count as one page.
    const root = await makeProject({
      "docs/both.mdx": "---\nnope: 1\n---\n\n<!-- x -->\n",
      "docs/broken.mdx": "---\ntitle: Broken\n---\n\nHello {oops\n",
      "docs/index.md": "# Home\n",
    });

    const built = await scanProject(root, { mode: "build" });
    expect(routesOf(built.manifest.routes)).toStrictEqual(["/"]);
    expect(built.droppedPages).toBe(2);
    expect(built.unparsable.toSorted()).toStrictEqual([
      join(root, "docs/both.mdx"),
      join(root, "docs/broken.mdx"),
    ]);
    expect(syntaxErrors(built)).toContainEqual(
      expect.objectContaining({
        file: join(root, "docs/broken.mdx"),
        line: 5,
        severity: "error",
      })
    );

    // Dev keeps the page, so opening it shows the error in place.
    const dev = await scanProject(root);
    expect(routesOf(dev.manifest.routes)).toStrictEqual(["/", "/broken"]);
    expect(dev.droppedPages).toBe(1);
    expect(dev.unparsable).toStrictEqual([]);
    expect(syntaxErrors(dev)).toHaveLength(2);
  });

  it("reports a parse error once when another diagnostic names its cause", async () => {
    // `{#setup}` is BLUME_MDX_CURLY_ANCHOR's (an error), and a partial's
    // attribute list BLUME_MDX_ATTRIBUTE_LIST's. A partial's error nothing
    // else names is a warning in the partial.
    const root = await makeProject({
      "docs/_partials/broken.md": "Text {1 +}\n",
      "docs/_partials/note.md": "Text\n{: .note }\n",
      "docs/anchor.mdx": "# Anchor\n\n## Setup {#setup}\n",
      "docs/index.mdx": "# Home\n\n<include>./_partials/note.md</include>\n",
      "docs/other.mdx": "# Other\n\n<include>./_partials/broken.md</include>\n",
    });
    const project = await scanProject(root, { mode: "build" });
    const codes = project.diagnostics.map((d) => `${d.code} ${d.file}`);
    expect(codes).toContain(
      `BLUME_MDX_CURLY_ANCHOR ${join(root, "docs/anchor.mdx")}`
    );
    expect(codes).toContain(
      `BLUME_MDX_ATTRIBUTE_LIST ${join(root, "docs/_partials/note.md")}`
    );
    expect(
      project.diagnostics.filter((d) => d.code === "BLUME_MDX_SYNTAX")
    ).toStrictEqual([
      expect.objectContaining({
        file: join(root, "docs/_partials/broken.md"),
        line: 1,
        severity: "warning",
      }),
    ]);
    // The page with the anchor still doesn't parse, so the build drops it.
    expect(project.unparsable).toStrictEqual([join(root, "docs/anchor.mdx")]);
  });

  it("applies CLI config overrides over the loaded config", async () => {
    const root = await makeProject({ "guides/index.md": "# Home\n" });
    const project = await scanProject(root, {
      overrides: { contentRoot: "guides" },
    });

    // `--content-dir` re-roots the (implicit) filesystem source.
    expect(project.config.content.sources[0]?.options).toMatchObject({
      root: "guides",
    });
    expect(project.context.contentRoot.endsWith("guides")).toBe(true);
    expect(project.droppedPages).toBe(0);
  });

  it("keeps the configured sources when the overrides name no content root", async () => {
    // `blume dev` without `--content-dir` still passes an overrides object.
    const root = await makeProject({
      "blume.config.ts": 'export default { content: { root: "guides" } };\n',
      "guides/index.md": "# Home\n",
    });
    const project = await scanProject(root, { overrides: {} });
    expect(project.config.content.sources[0]?.options).toMatchObject({
      root: "guides",
    });
    expect(routesOf(project.manifest.routes)).toStrictEqual(["/"]);
  });

  it("threads frontmatter.extend through to page validation", async () => {
    // A dependency-free Standard Schema, so the temp config needs no imports.
    const project = await scanProject(
      await makeProject({
        "blume.config.ts": `const owner = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string"
        ? { value }
        : { issues: [{ message: "must be a string" }] },
  },
};
export default { frontmatter: { extend: { owner } } };`,
        "docs/guide.md": "---\ntitle: Guide\nowner: docs-team\n---\n# Guide\n",
        "docs/index.md": "---\ntitle: Home\nowner: 5\n---\n# Home\n",
      })
    );
    const byRoute = new Map(
      project.graph.pages.map((page) => [page.route, page])
    );
    // The site-wide key applies to every page, so the one with a number for
    // an owner is rejected.
    expect(byRoute.get("/guide")?.custom).toStrictEqual({ owner: "docs-team" });
    expect(byRoute.has("/")).toBe(false);
    expect(project.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BLUME_FRONTMATTER_INVALID",
        message: expect.stringContaining("must be a string"),
      })
    );
  });

  it("drops each source redirect a page or a missing target rules out", async () => {
    const root = await makeProject({
      "blume.config.ts": `export default {
  content: {
    sources: [
      { kind: "filesystem", options: { root: "docs" }, requiredSecrets: [], runtimeDeps: [] },
      {
        kind: "custom",
        options: {
          load: () =>
            Promise.resolve({
              diagnostics: [],
              entries: [],
              redirects: [
                { from: "/old", to: "/missing" },
                { from: "/guide", to: "/" },
              ],
            }),
          name: "remote",
        },
        requiredSecrets: [],
        runtimeDeps: [],
      },
    ],
  },
};
`,
      "docs/guide.md": "# Guide\n",
      "docs/index.md": "# Home\n",
    });
    const project = await scanProject(root);
    // `/missing` isn't a page, and `/guide` is one, so neither redirect is added.
    expect(project.config.redirects).toStrictEqual([]);
    expect(routesOf(project.manifest.routes)).toStrictEqual(["/", "/guide"]);
  });

  it("keeps the platform site detection loadConfig ran", async () => {
    const root = await makeProject({ "docs/index.md": "# Home\n" });
    const saved = {
      VERCEL: process.env.VERCEL,
      VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    };
    process.env.VERCEL = "1";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "docs.example.com";
    try {
      const project = await scanProject(root, {
        mode: "build",
        overrides: { contentRoot: "docs" },
      });
      // Platform site resolution from loadConfig is preserved, not clobbered.
      expect(project.config.deployment.kind).toBe("static");
      expect(project.config.deployment.options.site).toBe(
        "https://docs.example.com"
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("throws a BlumeError when the content root is missing", async () => {
    const root = await makeProject({ "README.md": "# no docs here\n" });
    let thrown: unknown;
    try {
      await scanProject(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BlumeError);
    // SAFETY: asserted to be a BlumeError on the line above.
    expect((thrown as BlumeError).diagnostic.code).toBe(
      "BLUME_CONTENT_ROOT_MISSING"
    );
  });
});
