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

const CONTENT: Record<string, string> = {
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

  it("aggregates content diagnostics without throwing", async () => {
    const project = await scanProject(await makeProject(CONTENT));
    expect(project.diagnostics.map((d) => d.code)).toContain(
      "BLUME_FRONTMATTER_INVALID"
    );
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
    expect((thrown as BlumeError).diagnostic.code).toBe(
      "BLUME_CONTENT_ROOT_MISSING"
    );
  });
});
