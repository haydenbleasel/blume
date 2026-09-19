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
