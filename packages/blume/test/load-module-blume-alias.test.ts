import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { loadConfig } from "../src/core/config.ts";
import {
  blumeModuleAliases,
  createModuleLoader,
} from "../src/core/load-module.ts";
import { discoverFolderMeta } from "../src/core/meta.ts";
import { packageRoot } from "../src/core/package-root.ts";

// The fixtures live in `os.tmpdir()`, with no `node_modules` anywhere above
// them — the shape of a project whose content root sits outside it
// (`content.root: "../docs"`), where a module that imports `blume` can't find
// it by walking up from its own folder.
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeTree = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-outside-root-"));
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

describe("blumeModuleAliases", () => {
  it("pins blume and each subpath it exports to the running package", () => {
    const root = packageRoot();
    const aliases = blumeModuleAliases();

    expect(aliases.blume).toBe(join(root, "src/index.ts"));
    expect(aliases["blume/sources"]).toBe(join(root, "src/sources/index.ts"));
    expect(aliases["blume/package.json"]).toBe(join(root, "package.json"));
    // A wildcard export becomes a prefix alias, so the rest of the specifier
    // carries over (`blume/sources/*` maps under `src/core/sources/`).
    expect(aliases["blume/sources/"]).toBe(join(root, "src/core/sources/"));
    expect(aliases["blume/core/"]).toBe(join(root, "src/core/"));
    // A `.ts`-only wildcard (`./search/*.ts`) aliases the same prefix, and
    // no alias keeps a literal `*` that jiti could never match.
    expect(aliases["blume/search/"]).toBe(join(root, "src/search/"));
    expect(
      Object.entries(aliases).filter(([alias, target]) =>
        `${alias}${target}`.includes("*")
      )
    ).toEqual([]);
  });

  it("reads the package manifest once", () => {
    expect(blumeModuleAliases()).toBe(blumeModuleAliases());
  });
});

describe("modules loaded from outside the project", () => {
  // A `blume` import Bun can't resolve sends the file to jiti's compiler,
  // whose Babel wraps Error.prepareStackTrace on its first compile. Under Bun
  // that wrapper crashes Vite's import later in the process.
  it("leaves Error.prepareStackTrace as it was after compiling a module", async () => {
    const root = await makeTree({
      "docs/meta.ts":
        'import { defineMeta } from "blume";\n\nexport default defineMeta({ title: "Compiled" });\n',
    });
    const { prepareStackTrace } = Error;

    const loaded = await createModuleLoader()(join(root, "docs/meta.ts"));

    expect(loaded).toStrictEqual({ title: "Compiled" });
    expect(Error.prepareStackTrace).toBe(prepareStackTrace);
  });

  it("resolves blume and its subpaths in a meta.ts with no blume above it", async () => {
    const root = await makeTree({
      "docs/guide/meta.ts": [
        'import { defineMeta } from "blume";',
        'import { defineMeta as direct } from "blume/core/define-meta.ts";',
        'import { folderMetaSchema } from "blume/schema";',
        'import { filesystem } from "blume/sources";',
        "",
        "export default defineMeta(",
        "  direct(folderMetaSchema.parse({ title: filesystem().kind }))",
        ");",
        "",
      ].join("\n"),
    });

    const { diagnostics, meta } = await discoverFolderMeta(join(root, "docs"));

    expect(diagnostics).toStrictEqual([]);
    expect(meta.get("guide")).toStrictEqual({ title: "filesystem" });
  });

  it("resolves blume in a file blume.config.ts imports from outside the project", async () => {
    const root = await makeTree({
      "book/blume.config.ts":
        'import site from "../shared/site.ts";\n\nexport default site;\n',
      "shared/site.ts": [
        'import { defineConfig } from "blume";',
        "",
        'export default defineConfig({ content: { root: "../docs" }, title: "Shared" });',
        "",
      ].join("\n"),
    });

    const { config } = await loadConfig(join(root, "book"));

    expect(config.title).toBe("Shared");
  });
});
