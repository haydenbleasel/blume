import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { findFolderMetaFiles } from "../src/core/meta.ts";
import { discoverTranslatableMeta } from "../src/translate/meta.ts";
import { scanForTranslation } from "../src/translate/work-list.ts";

/**
 * `blume translate` finds the folder meta it translates through the scan's own
 * file set: a `meta.ts` in a folder the source's `include` globs never reach
 * configures no sidebar group, so it has no title to translate either.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-translate-meta-include-"));
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

const PROJECT = {
  "blume.config.ts": `export default {
  title: "Test",
  content: { root: ".", include: ["docs/**/*.{md,mdx}"] },
  i18n: {
    defaultLocale: "en",
    locales: [
      { code: "en", label: "English" },
      { code: "fr", label: "Français" },
    ],
  },
};
`,
  "docs/guides/intro.md": "---\ntitle: Intro\n---\n# Intro\n",
  "docs/guides/meta.ts": 'export default { title: "Guides" };\n',
  "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
  // Beside the docs, outside every include glob: not folder meta.
  "tools/meta.ts": 'export default { title: "Tooling" };\n',
};

describe("translate meta discovery include scope", () => {
  it("skips a meta.ts in a folder the include globs don't reach", async () => {
    const root = await fixture(PROJECT);
    const project = await scanForTranslation(root);
    const { metas } = await discoverTranslatableMeta(project);
    expect(metas.map((meta) => meta.sourceRel)).toEqual([
      "docs/guides/meta.ts",
    ]);
  });

  it("finds the same files the scan reads, shared meta included", async () => {
    const root = await fixture({
      ...PROJECT,
      "docs/meta.$.ts": 'export default { title: "Docs" };\n',
    });
    const files = await findFolderMetaFiles({
      include: ["docs/**/*.{md,mdx}"],
      root,
    });
    expect(files.map((file) => file.slice(root.length + 1)).toSorted()).toEqual(
      ["docs/guides/meta.ts", "docs/meta.$.ts"]
    );
  });
});
