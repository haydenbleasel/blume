import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import { blumeDepsDir, ensureDepsLink } from "../src/astro/generate.ts";

// `ensureDepsLink` proves out by making Astro resolvable from `.blume/`. We
// assert that at the filesystem level — `existsSync`/`readlink` through the
// link, the exact path node's resolver walks — rather than via in-process
// `require.resolve`. Under Node (the CLI's runtime) a fresh symlink resolves
// immediately; `bun test` runs under Bun, whose resolver caches the pre-symlink
// negative lookup in-process, so a post-link `require.resolve` would lie.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-deps-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

// Write a minimal, node-resolvable package at `<dir>/<name>/package.json`. No
// `exports` field, so a bare `<name>/package.json` subpath stays resolvable.
const fakePackage = async (dir: string, name: string): Promise<void> => {
  const pkgDir = join(dir, name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "0.0.0" }),
    "utf-8"
  );
};

// Whether `astro/package.json` resolves from a directory — the same node
// resolution the generated `.blume/` config relies on.
const resolvesAstro = (fromDir: string): boolean => {
  try {
    createRequire(pathToFileURL(join(fromDir, "_.js")).href).resolve(
      "astro/package.json"
    );
    return true;
  } catch {
    return false;
  }
};

// An isolated-linker layout: Blume sits in a virtual store with its deps as
// siblings, and `.blume/` lives in a project that can't walk up to them.
const isolatedFixture = async (): Promise<{
  outDir: string;
  pkgDir: string;
  store: string;
}> => {
  const store = join(root, "node_modules", ".store", "blume@1", "node_modules");
  const pkgDir = join(store, "blume");
  await mkdir(pkgDir, { recursive: true });
  await fakePackage(store, "astro");
  await fakePackage(store, "@astrojs/mdx");
  const outDir = join(root, "project", ".blume");
  await mkdir(outDir, { recursive: true });
  return { outDir, pkgDir, store };
};

describe("blumeDepsDir", () => {
  it("finds deps nested under the package (workspace source layout)", async () => {
    const pkgDir = join(root, "pkg");
    await mkdir(join(pkgDir, "node_modules"), { recursive: true });
    await fakePackage(join(pkgDir, "node_modules"), "astro");

    expect(blumeDepsDir(pkgDir)).toBe(join(pkgDir, "node_modules"));
  });

  it("finds deps as siblings in the store (isolated linker layout)", async () => {
    const { pkgDir, store } = await isolatedFixture();

    // Nested candidate is absent, so it falls through to the package's parent.
    expect(existsSync(join(pkgDir, "node_modules"))).toBe(false);
    expect(blumeDepsDir(pkgDir)).toBe(store);
  });

  it("returns null when Astro isn't found next to the package", async () => {
    const pkgDir = join(root, "lonely", "blume");
    await mkdir(pkgDir, { recursive: true });

    expect(blumeDepsDir(pkgDir)).toBeNull();
  });
});

describe("ensureDepsLink", () => {
  it("symlinks Blume's deps into .blume under an isolated linker", async () => {
    const { outDir, pkgDir, store } = await isolatedFixture();
    // Precondition: the project genuinely can't reach Astro on its own.
    expect(resolvesAstro(outDir)).toBe(false);

    await ensureDepsLink(outDir, pkgDir);

    const link = join(outDir, "node_modules");
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(store);
    // Every bare specifier the generated config names now resolves through the
    // link — including scoped integrations that live as store siblings.
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
    expect(existsSync(join(link, "@astrojs", "mdx", "package.json"))).toBe(
      true
    );

    // Idempotent: a second pass leaves a working link in place.
    await ensureDepsLink(outDir, pkgDir);
    const after = await lstat(link);
    expect(after.isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
  });

  it("is a no-op when Astro already resolves (hoisted install)", async () => {
    const outDir = join(root, "app", ".blume");
    await mkdir(join(root, "app", "node_modules"), { recursive: true });
    await fakePackage(join(root, "app", "node_modules"), "astro");
    await mkdir(outDir, { recursive: true });
    expect(resolvesAstro(outDir)).toBe(true);

    await ensureDepsLink(outDir, join(root, "does-not-matter"));

    expect(existsSync(join(outDir, "node_modules"))).toBe(false);
  });

  it("does nothing when Blume's deps can't be located", async () => {
    const outDir = join(root, "p", ".blume");
    await mkdir(outDir, { recursive: true });
    const pkgDir = join(root, "p", "node_modules", "blume");
    await mkdir(pkgDir, { recursive: true });
    expect(resolvesAstro(outDir)).toBe(false);

    await ensureDepsLink(outDir, pkgDir);

    expect(existsSync(join(outDir, "node_modules"))).toBe(false);
  });

  it("replaces a stale link that no longer resolves Astro", async () => {
    const { outDir, pkgDir, store } = await isolatedFixture();
    const link = join(outDir, "node_modules");
    const staleTarget = join(root, "stale");
    await mkdir(staleTarget, { recursive: true });
    await symlink(staleTarget, link, "junction");
    expect(resolvesAstro(outDir)).toBe(false);

    await ensureDepsLink(outDir, pkgDir);

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    // Re-pointed from the stale target to Blume's real store directory.
    expect(await readlink(link)).toBe(store);
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
  });

  it("leaves a real node_modules directory untouched", async () => {
    const { outDir, pkgDir } = await isolatedFixture();
    const link = join(outDir, "node_modules");
    await mkdir(link, { recursive: true });
    await writeFile(join(link, "marker.txt"), "keep", "utf-8");
    expect(resolvesAstro(outDir)).toBe(false);

    await ensureDepsLink(outDir, pkgDir);

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isDirectory()).toBe(true);
    expect(existsSync(join(link, "marker.txt"))).toBe(true);
  });
});
