import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { discoverIslands } from "../src/astro/islands.ts";
import { discoverPages } from "../src/astro/pages.ts";
import { validateLinks } from "../src/core/links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { serverFeatures } from "../src/core/server-features.ts";

/**
 * Fixture matrix: whole projects exercised end-to-end through the core pipeline,
 * covering the scenarios the pieces are unit-tested for in isolation —
 * static/server deploy, broken links, invalid frontmatter, nested nav, a custom
 * `.astro` page, and a React island — so the integration keeps working together.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-fixture-"));
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

const page = (title: string, body = "Body."): string =>
  `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;

describe("fixture matrix", () => {
  it("builds a clean nested-nav project with no diagnostics", async () => {
    const root = await fixture({
      "docs/guides/advanced/deep.md": page("Deep"),
      "docs/guides/intro.md": page("Intro"),
      "docs/index.md": page("Home"),
    });
    const project = await scanProject(root, { mode: "build" });

    expect(project.diagnostics).toEqual([]);
    expect(project.graph.routes.has("/")).toBe(true);
    expect(project.graph.routes.has("/guides/advanced/deep")).toBe(true);
    // The nested folder becomes a sidebar group.
    const labels = JSON.stringify(project.graph.navigation.sidebar);
    expect(labels).toContain("Guides");
  });

  it("reports a broken internal link", async () => {
    const root = await fixture({
      "docs/index.md": page("Home", "See [missing](/does-not-exist)."),
    });
    const project = await scanProject(root, { mode: "build" });
    const diagnostics = await validateLinks(project.graph, {
      checkExternal: false,
      publicDir: null,
      redirects: [],
    });
    expect(diagnostics.some((d) => d.code === "BLUME_BROKEN_LINK")).toBe(true);
  });

  it("flags invalid frontmatter with a line/column", async () => {
    const root = await fixture({
      "docs/bad.md": '---\ntitle: Bad\nseo:\n  noindex: "nope"\n---\n# Bad\n',
      "docs/index.md": page("Home"),
    });
    const project = await scanProject(root, { mode: "build" });
    const invalid = project.diagnostics.find(
      (d) => d.code === "BLUME_FRONTMATTER_INVALID"
    );
    expect(invalid).toBeDefined();
    expect(invalid?.line).toBeGreaterThan(0);
  });

  it("discovers a custom .astro page and a React island", async () => {
    const root = await fixture({
      "docs/index.md": page("Home"),
      "islands/Counter.tsx":
        "export default function Counter() { return null; }\n",
      "pages/pricing.astro": "<h1>Pricing</h1>\n",
    });
    const [pages, islands] = await Promise.all([
      discoverPages(join(root, "pages")),
      discoverIslands(root),
    ]);
    expect(pages.map((p) => p.pattern)).toContain("/pricing");
    expect(islands.islands.map((i) => i.name)).toContain("Counter");
    expect(islands.islands[0]?.framework).toBe("react");
  });

  it("gates server-only features by deployment output", async () => {
    const askConfig =
      'export default { ai: { ask: { enabled: true } }, deployment: { output: "OUTPUT" } };\n';
    const staticRoot = await fixture({
      "blume.config.ts": askConfig.replace("OUTPUT", "static"),
      "docs/index.md": page("Home"),
    });
    const serverRoot = await fixture({
      "blume.config.ts": askConfig.replace("OUTPUT", "server"),
      "docs/index.md": page("Home"),
    });
    const [staticProject, serverProject] = await Promise.all([
      scanProject(staticRoot, { mode: "build" }),
      scanProject(serverRoot, { mode: "build" }),
    ]);
    // Ask AI is a server feature: it can't ship in a static build.
    expect(serverFeatures(staticProject.config)).toContain("Ask AI");
    expect(staticProject.config.deployment.output).toBe("static");
    expect(serverProject.config.deployment.output).toBe("server");
  });
});
