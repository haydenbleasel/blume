import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { folderMetaDiagnostics } from "../src/core/meta-diagnostics.ts";
import { discoverFolderMeta } from "../src/core/meta.ts";
import { folderChildKeys } from "../src/core/navigation.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { Diagnostic, PageRecord } from "../src/core/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeTree = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-meta-diagnostics-"));
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

// SAFETY: folderMetaDiagnostics reads only a page's nav path.
const page = (navPath: string): PageRecord => ({ navPath }) as PageRecord;

const byCode = (diagnostics: Diagnostic[], code: string): Diagnostic[] =>
  diagnostics.filter((diagnostic) => diagnostic.code === code);

describe("folderChildKeys", () => {
  it("keys each folder's pages and subfolders as a pages list names them", () => {
    const keys = folderChildKeys([
      "01-intro.mdx",
      "guides/(basics)/02-setup.md",
      "guides/index.mdx",
    ]);
    expect(Object.fromEntries(keys)).toStrictEqual({
      "": new Set(["intro", "guides"]),
      guides: new Set(["basics", "index"]),
      "guides/(basics)": new Set(["setup"]),
    });
  });
});

describe("BLUME_META_UNKNOWN_PAGE", () => {
  // The first meta.ts in the run to import `blume`, so jiti compiles Blume's
  // source cold here: under 2s on Linux, up to 9s on Windows.
  it("names each pages entry that matches no child, with its line and a likely fix", async () => {
    const root = await makeTree({
      "guides/meta.ts": [
        'import { defineMeta } from "blume";',
        "",
        "export default defineMeta({",
        "  pages: [",
        '    "setup",',
        '    "01-advanced.mdx",',
        '    "deploymnt",',
        '    "ghost",',
        '    "draft",',
        "  ],",
        "});",
        "",
      ].join("\n"),
    });
    const discovered = await discoverFolderMeta(root);
    const diagnostics = await folderMetaDiagnostics(discovered, [
      page("guides/setup.md"),
      page("guides/01-advanced/index.md"),
      page("guides/deployment.md"),
      // A draft or hidden page is still a page the list can name.
      page("guides/draft.md"),
    ]);
    expect(diagnostics).toStrictEqual([
      expect.objectContaining({
        file: join(root, "guides/meta.ts"),
        line: 6,
        message: expect.stringContaining('"01-advanced.mdx"'),
        suggestion: expect.stringContaining('Did you mean "advanced"?'),
      }),
      expect.objectContaining({
        line: 7,
        suggestion: expect.stringContaining('Did you mean "deployment"?'),
      }),
      expect.objectContaining({
        line: 8,
        message:
          'pages lists "ghost", but no page or folder in "guides" has that slug, so the entry orders nothing.',
        suggestion: expect.not.stringContaining("Did you mean"),
      }),
    ]);
    expect(byCode(diagnostics, "BLUME_META_UNKNOWN_PAGE")).toHaveLength(3);
  }, 30_000);

  it("checks a locale's and a version's meta against the pages' nav paths", async () => {
    const root = await makeTree({
      "fr/meta.ts": 'export default { pages: ["accueil", "intro"] };\n',
      "meta.$.ts": 'export default { pages: ["intro"] };\n',
      "v1.0/fr/guides/meta.ts": 'export default { pages: ["setup"] };\n',
    });
    const discovered = await discoverFolderMeta(root, {
      localeDirs: ["fr"],
      versionDirs: ["v1.0"],
    });
    const diagnostics = await folderMetaDiagnostics(
      discovered,
      [page("intro.md"), page("guides/setup.md")],
      { localeDirs: ["fr"], versionDirs: ["v1.0"] }
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toStrictEqual([
      'pages lists "accueil", but no page or folder in the content root has that slug, so the entry orders nothing.',
    ]);
  });

  it("reports an unknown entry from a project scan", async () => {
    const root = await makeTree({
      "docs/guides/meta.ts": 'export default { pages: ["setup", "nope"] };\n',
      "docs/guides/setup.md": "# Setup\n",
      "docs/index.md": "# Home\n",
    });
    const project = await scanProject(root);
    expect(
      byCode(project.diagnostics, "BLUME_META_UNKNOWN_PAGE").map(
        (diagnostic) => diagnostic.message
      )
    ).toStrictEqual([
      'pages lists "nope", but no page or folder in "guides" has that slug, so the entry orders nothing.',
    ]);
  });
});

describe("BLUME_META_OUTSIDE_INCLUDE", () => {
  it("counts a file another source sharing the root reads as read", async () => {
    const root = await makeTree({
      "docs/meta.ts": 'export default { title: "Docs" };\n',
      "guides/meta.ts": 'export default { title: "Guides" };\n',
      "scripts/meta.ts": "export default { runtime: 'edge' };\n",
    });
    const discovered = await discoverFolderMeta([
      { include: ["docs/**/*.md"], root },
      { include: ["guides/**/*.md"], prefix: "guides", root },
    ]);
    expect(discovered.unread.map((entry) => entry.dir)).toStrictEqual([
      "scripts",
      "scripts",
    ]);
  });

  it("warns about a reference tag folder's meta.ts no include glob reaches", async () => {
    const root = await makeTree({
      "blume.config.ts":
        'export default {\n  content: { include: ["guides/**/*.md"] },\n  reference: [{ kind: "openapi", options: { route: "/api", spec: "./openapi.json" }, requiredSecrets: [], runtimeDeps: [] }],\n};\n',
      // Its folder holds the generated Pets pages.
      "docs/api/pets/meta.ts": 'export default { title: "Animals" };\n',
      "docs/guides/setup.md": "# Setup\n",
      // Application code named meta.ts, in a folder no page lives in.
      "docs/scripts/meta.ts": "export default { runtime: 'edge' };\n",
      "openapi.json": JSON.stringify({
        info: { title: "API", version: "1" },
        openapi: "3.1.0",
        paths: {
          "/pets": {
            get: { operationId: "listPets", summary: "List", tags: ["Pets"] },
          },
        },
      }),
    });
    const project = await scanProject(root);
    expect(
      byCode(project.diagnostics, "BLUME_META_OUTSIDE_INCLUDE")
    ).toStrictEqual([
      expect.objectContaining({
        file: join(root, "docs/api/pets/meta.ts"),
        message:
          "This meta file is in the \"api/pets\" sidebar group's folder, but no include glob of its content source reaches that folder, so Blume doesn't read it.",
        severity: "warning",
        suggestion:
          'Add an include glob that reaches the folder, such as "api/pets/**/*.{md,mdx}".',
      }),
    ]);
  });
});
