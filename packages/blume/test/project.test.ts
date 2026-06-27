import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { findConfigFile, resolveProjectContext } from "../src/core/project.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

const dirs: string[] = [];

const makeDir = async (files: string[]): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-project-"));
  dirs.push(dir);
  await Promise.all(
    files.map((rel) =>
      rel.endsWith("/")
        ? mkdir(join(dir, rel), { recursive: true })
        : writeFile(join(dir, rel), "")
    )
  );
  return dir;
};

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("findConfigFile", () => {
  it("prefers blume.config.ts over other extensions", async () => {
    const dir = await makeDir(["blume.config.js", "blume.config.ts"]);
    expect(findConfigFile(dir)).toBe(join(dir, "blume.config.ts"));
  });

  it("falls back to .js when no .ts exists", async () => {
    const dir = await makeDir(["blume.config.js"]);
    expect(findConfigFile(dir)).toBe(join(dir, "blume.config.js"));
  });

  it("returns null when no config file exists", async () => {
    const dir = await makeDir([]);
    expect(findConfigFile(dir)).toBeNull();
  });
});

describe("resolveProjectContext", () => {
  const defaults = blumeConfigSchema.parse({});

  it("resolves every project path from the root and config", async () => {
    const dir = await makeDir([
      "blume.config.ts",
      "components.ts",
      "pages/",
      "theme.css",
    ]);
    const ctx = resolveProjectContext(dir, defaults);

    expect(ctx.root).toBe(dir);
    expect(ctx.contentRoot).toBe(join(dir, "docs"));
    expect(ctx.outDir).toBe(join(dir, ".blume"));
    expect(ctx.pagesRoot).toBe(join(dir, "pages"));
    expect(ctx.componentsFile).toBe(join(dir, "components.ts"));
    expect(ctx.themeFile).toBe(join(dir, "theme.css"));
    expect(ctx.configFile).toBe(join(dir, "blume.config.ts"));
  });

  it("leaves optional paths null when their files are absent", async () => {
    const dir = await makeDir([]);
    const ctx = resolveProjectContext(dir, defaults);
    expect(ctx.pagesRoot).toBeNull();
    expect(ctx.componentsFile).toBeNull();
    expect(ctx.themeFile).toBeNull();
    expect(ctx.configFile).toBeNull();
  });

  it("keeps an absolute content root unchanged", async () => {
    const dir = await makeDir([]);
    const config = blumeConfigSchema.parse({
      content: { root: "/abs/content" },
    });
    expect(resolveProjectContext(dir, config).contentRoot).toBe("/abs/content");
  });
});
