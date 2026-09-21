import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import {
  blumeDepsDir,
  ensureDepsLink,
  prerenderDepsPlugin,
  symlinkDir,
} from "../src/astro/generate.ts";

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

const normalizeSlashes = (value: string): string => value.replaceAll("\\", "/");

const expectLinkTarget = async (
  link: string,
  target: string
): Promise<void> => {
  expect(normalizeSlashes(await readlink(link))).toBe(normalizeSlashes(target));
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

// A hoisted layout where a sibling pulled a *different* astro to the project
// root, shadowing Blume's own. `.blume/` resolves the wrong one by walking up,
// while Blume's matching astro lives nested under the package. `mdxCoLocated`
// toggles whether Blume's integration sits beside its astro (a repairable set)
// or is hoisted away from it (a split layout only a root override can fix).
const hoistedConflictFixture = async (
  mdxCoLocated = true
): Promise<{ depsDir: string; outDir: string; pkgDir: string }> => {
  const projectModules = join(root, "node_modules");
  await fakePackage(projectModules, "astro");
  const pkgDir = join(projectModules, "blume");
  const depsDir = join(pkgDir, "node_modules");
  await fakePackage(depsDir, "astro");
  // Co-located: the integration sits beside Blume's astro (a repairable set).
  // Split: it's hoisted beside the shadowing astro instead.
  await fakePackage(mdxCoLocated ? depsDir : projectModules, "@astrojs/mdx");
  const outDir = join(root, ".blume");
  await mkdir(outDir, { recursive: true });
  return { depsDir, outDir, pkgDir };
};

// npm's split install (issue #90): an `overrides` astro pin plus an incremental
// `npm install` hoists astro to the project root — deleting Blume's nested copy
// — but keeps the existing nested placement for Blume's other deps. The root
// astro IS Blume's astro (npm deduped to a single copy); only the integrations
// are stranded where `.blume/` can't walk up to them.
const npmSplitFixture = async (): Promise<{
  nestedDeps: string;
  outDir: string;
  pkgDir: string;
}> => {
  const projectModules = join(root, "node_modules");
  await fakePackage(projectModules, "astro");
  const pkgDir = join(projectModules, "blume");
  const nestedDeps = join(pkgDir, "node_modules");
  await fakePackage(nestedDeps, "@astrojs/mdx");
  const outDir = join(root, ".blume");
  await mkdir(outDir, { recursive: true });
  return { nestedDeps, outDir, pkgDir };
};

describe("symlinkDir", () => {
  it("creates a directory link that resolves the target", async () => {
    const target = join(root, "target");
    await fakePackage(target, "astro");
    const link = join(root, "link");

    await symlinkDir(target, link);

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, target);
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
  });

  it("falls back to a junction when a directory symlink can't be created", async () => {
    // Windows without symlink privilege: the "dir" attempt fails with EPERM
    // and the junction attempt must still yield a working link. On POSIX the
    // two calls are the same syscall, so the first is made to fail here.
    const target = join(root, "target");
    await fakePackage(target, "astro");
    const link = join(root, "link");
    const realSymlink = fsPromises.symlink;
    const types: string[] = [];
    const spy = spyOn(fsPromises, "symlink").mockImplementation(
      (symlinkTarget, path, type) => {
        types.push(String(type));
        if (type === "dir") {
          return Promise.reject(
            Object.assign(new Error("EPERM: operation not permitted"), {
              code: "EPERM",
            })
          );
        }
        return realSymlink(symlinkTarget, path, type);
      }
    );
    try {
      await symlinkDir(target, link);
    } finally {
      spy.mockRestore();
    }

    expect(types).toEqual(["dir", "junction"]);
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, target);
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
  });

  it("surfaces the error when the junction fallback fails too", async () => {
    // A directory symlink is tried first (Windows needs symlink privilege for
    // it); when that fails, a junction is tried. Both fail on an occupied
    // path, so the junction attempt's error is what reaches the caller.
    const link = join(root, "taken");
    await writeFile(link, "", "utf-8");

    await expect(symlinkDir(join(root, "target"), link)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
});

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

  it("prefers the dir holding the integrations when astro was hoisted away", async () => {
    // npm split install: probing for astro alone would pick the project root,
    // which holds none of Blume's other deps (zod, sharp, …) — they stayed
    // nested beside @astrojs/mdx.
    const { nestedDeps, pkgDir } = await npmSplitFixture();

    expect(blumeDepsDir(pkgDir)).toBe(nestedDeps);
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
    await expectLinkTarget(link, store);
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

  it("links when the workspace's own astro dedupes to Blume's copy (issue #103)", async () => {
    // Bun's isolated linker + the workspace declaring astro at a version
    // matching Blume's. The workspace's node_modules holds only its direct
    // deps, but its astro symlink dedupes to the very store entry Blume's set
    // uses — so the walk from `.blume/` resolves the "correct" astro from a
    // directory holding none of Blume's integrations. The junction is still
    // required, or `@astrojs/mdx` is unresolvable and the build dies.
    const { outDir, pkgDir, store } = await isolatedFixture();
    const projectModules = join(root, "project", "node_modules");
    await mkdir(projectModules, { recursive: true });
    await symlink(
      join(store, "astro"),
      join(projectModules, "astro"),
      "junction"
    );
    // The trap: astro already resolves from `.blume/`, and to the right copy.
    expect(resolvesAstro(outDir)).toBe(true);

    await ensureDepsLink(outDir, pkgDir);

    const link = join(outDir, "node_modules");
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, store);
    expect(existsSync(join(link, "@astrojs", "mdx", "package.json"))).toBe(
      true
    );
  });

  it("links when pnpm's bin shim exposes Astro only through NODE_PATH", async () => {
    const { outDir, pkgDir, store } = await isolatedFixture();
    const generateUrl = pathToFileURL(
      join(import.meta.dir, "../src/astro/generate.ts")
    ).href;
    const script = `
      const { ensureDepsLink } = await import(${JSON.stringify(generateUrl)});
      await ensureDepsLink(${JSON.stringify(outDir)}, ${JSON.stringify(pkgDir)});
    `;

    // pnpm's generated `node_modules/.bin/blume` wrapper prepends this virtual
    // store directory to NODE_PATH. CommonJS `require.resolve` sees Astro there,
    // while the generated config's ESM `import "astro/config"` does not. Run in
    // a child process because NODE_PATH is read when the runtime starts.
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, NODE_PATH: store },
      stderr: "pipe",
      stdout: "ignore",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(stderr);
    }

    const link = join(outDir, "node_modules");
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, store);
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

  it("is a no-op when .blume resolves Blume's own hoisted astro", async () => {
    // Clean hoist: Blume's astro + integration sit at the project root, and
    // `.blume/` walks up to the very same copy Blume uses. Nothing to repair.
    const projectModules = join(root, "node_modules");
    await fakePackage(projectModules, "astro");
    await fakePackage(projectModules, "@astrojs/mdx");
    const pkgDir = join(projectModules, "blume");
    await mkdir(pkgDir, { recursive: true });
    const outDir = join(root, ".blume");
    await mkdir(outDir, { recursive: true });

    await ensureDepsLink(outDir, pkgDir);

    expect(existsSync(join(outDir, "node_modules"))).toBe(false);
  });

  it("links Blume's deps when the project resolves a shadowing astro", async () => {
    // A hoisted sibling pulled a *different* astro to the project root; `.blume/`
    // resolves it by walking up. Astro "resolves", but to the wrong copy — the
    // old can-astro-resolve guard skipped this and @astrojs/mdx bound to the
    // shadow. Now we link Blume's own consistent (astro + mdx) set in.
    const { depsDir, outDir, pkgDir } = await hoistedConflictFixture();
    expect(resolvesAstro(outDir)).toBe(true);

    await ensureDepsLink(outDir, pkgDir);

    const link = join(outDir, "node_modules");
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, depsDir);
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
    expect(existsSync(join(link, "@astrojs", "mdx", "package.json"))).toBe(
      true
    );
  });

  it("links the nested integrations when npm hoists astro away from them", async () => {
    // Issue #90: astro hoisted to the root (an `overrides` pin + incremental
    // `npm install`), @astrojs/mdx left nested. `.blume/` resolves the right
    // astro but not the integrations. The junction must link the nested dir —
    // it holds no `astro` entry, so astro lookups still fall through to the
    // hoisted copy the integrations bind to.
    const { nestedDeps, outDir, pkgDir } = await npmSplitFixture();
    expect(resolvesAstro(outDir)).toBe(true);

    const warning = await ensureDepsLink(outDir, pkgDir);

    expect(warning).toBeNull();
    const link = join(outDir, "node_modules");
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, nestedDeps);
    expect(existsSync(join(link, "@astrojs", "mdx", "package.json"))).toBe(
      true
    );
    // Astro is deliberately NOT shadowed by the junction; it keeps resolving
    // from the hoisted copy through the ancestor walk.
    expect(existsSync(join(link, "astro"))).toBe(false);
    expect(resolvesAstro(outDir)).toBe(true);
  });

  it("leaves a junction already pointing at the right target in place", async () => {
    // Second dev regeneration of the npm split layout: the walk still resolves
    // astro from the hoisted root (the junction holds no `astro` entry), so the
    // linking path runs again — and must leave the correct junction alone. An
    // unconditional rm+recreate would open a window in which the Vite server's
    // module resolution races a missing `node_modules` and 500s.
    const { nestedDeps, outDir, pkgDir } = await npmSplitFixture();
    await ensureDepsLink(outDir, pkgDir);
    const link = join(outDir, "node_modules");
    await expectLinkTarget(link, nestedDeps);

    await ensureDepsLink(outDir, pkgDir);

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, nestedDeps);
  });

  it("warns (without linking) on a split layout the symlink can't fix", async () => {
    // Blume's astro is nested but @astrojs/mdx is hoisted beside the shadowing
    // astro — no single directory holds a consistent set, so a symlink can't
    // fix it. We leave it for a root `overrides`/`resolutions` pin rather than
    // half-fix astro while mdx still binds to the wrong copy, and surface an
    // actionable diagnostic instead of silently shipping a broken runtime.
    const { outDir, pkgDir } = await hoistedConflictFixture(false);

    const warning = await ensureDepsLink(outDir, pkgDir);

    expect(existsSync(join(outDir, "node_modules"))).toBe(false);
    expect(warning).toMatch(/Astro version conflict/u);
    expect(warning).toMatch(/overrides/u);
    expect(warning).toMatch(/"astro"/u);
  });

  it("returns null (no warning) when it links or no-ops", async () => {
    // The repairable and clean cases must stay quiet — a warning only belongs to
    // the unfixable split layout.
    const isolated = await isolatedFixture();
    expect(await ensureDepsLink(isolated.outDir, isolated.pkgDir)).toBeNull();

    const conflict = await hoistedConflictFixture();
    expect(await ensureDepsLink(conflict.outDir, conflict.pkgDir)).toBeNull();
  });

  it("still warns when the conflicting Astro versions can't be read", async () => {
    // Same split layout, but the astro package.json files are unparseable. The
    // diagnostic degrades to a version-less message instead of crashing.
    const projectModules = join(root, "node_modules");
    const pkgDir = join(projectModules, "blume");
    const depsDir = join(pkgDir, "node_modules");
    await Promise.all(
      [projectModules, depsDir].map(async (dir) => {
        await mkdir(join(dir, "astro"), { recursive: true });
        await writeFile(
          join(dir, "astro", "package.json"),
          "{ not json",
          "utf-8"
        );
      })
    );
    // @astrojs/mdx hoisted away from Blume's nested astro — the split layout.
    await fakePackage(projectModules, "@astrojs/mdx");
    const outDir = join(root, ".blume");
    await mkdir(outDir, { recursive: true });

    const warning = await ensureDepsLink(outDir, pkgDir);

    expect(warning).toMatch(/Astro version conflict/u);
    expect(warning).toMatch(/a second copy of Astro/u);
    expect(warning).toMatch(/<Blume's astro version>/u);
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
    await expectLinkTarget(link, store);
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
  });

  it("re-points a cached junction that resolves a superseded Blume", async () => {
    // A restored build cache (Vercel) resurrects `.blume/node_modules` as a
    // junction into the *previous* release's store directory. That directory
    // still holds the same astro — releases rarely bump it — so every
    // astro-based probe passes through the link, but `blume/*` imports in the
    // freshly generated config would load the old package and crash on any
    // export added since (the 1.1.1 `blumeTwoslashTransformer` incident).
    const { outDir, pkgDir, store } = await isolatedFixture();
    const staleStore = join(
      root,
      "node_modules",
      ".store",
      "blume@0",
      "node_modules"
    );
    await fakePackage(staleStore, "astro");
    await fakePackage(staleStore, "@astrojs/mdx");
    await fakePackage(staleStore, "blume");
    const link = join(outDir, "node_modules");
    await symlink(staleStore, link, "junction");
    // The trap: astro is perfectly resolvable through the stale link.
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);

    await ensureDepsLink(outDir, pkgDir);

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, store);
    // `blume` now resolves to the running package, not the superseded one.
    expect(await realpath(join(link, "blume"))).toBe(await realpath(pkgDir));
  });

  it("keeps a junction whose target holds only deps, never Blume itself", async () => {
    // Workspace source layout: the junction points at Blume's own
    // `node_modules`, which holds the deps but not `blume` — the package
    // resolves through the ordinary ancestor walk instead. No `blume` entry
    // means no staleness verdict, so the link must survive a second pass.
    const pkgDir = join(root, "packages", "blume");
    const depsDir = join(pkgDir, "node_modules");
    await fakePackage(depsDir, "astro");
    await fakePackage(depsDir, "@astrojs/mdx");
    const outDir = join(root, "project", ".blume");
    await mkdir(outDir, { recursive: true });
    await ensureDepsLink(outDir, pkgDir);
    const link = join(outDir, "node_modules");
    await expectLinkTarget(link, depsDir);

    await ensureDepsLink(outDir, pkgDir);

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, depsDir);
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

describe("prerenderDepsPlugin", () => {
  // The plugin's only job is to drop a `node_modules` junction into Astro's
  // `.prerender/` output so the prerender bundle's externalized deps resolve
  // under an isolated linker. Drive its `writeBundle` hook directly with the
  // output dir Astro would pass for each Vite environment.
  const prerenderDir = async (): Promise<string> => {
    const dir = join(root, "dist", ".prerender");
    await mkdir(dir, { recursive: true });
    return dir;
  };

  it("links Blume's deps into the prerender output under an isolated linker", async () => {
    const { pkgDir, store } = await isolatedFixture();
    const dir = await prerenderDir();

    await prerenderDepsPlugin(pkgDir).writeBundle({ dir });

    const link = join(dir, "node_modules");
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    await expectLinkTarget(link, store);
    // The externalized specifiers Node walks up to find now resolve.
    expect(existsSync(join(link, "astro", "package.json"))).toBe(true);
    expect(resolvesAstro(join(dir, "chunks"))).toBe(true);
  });

  it("ignores non-prerender environment outputs (client, ssr)", async () => {
    const { pkgDir } = await isolatedFixture();
    const clientDir = join(root, "dist");
    const ssrDir = join(root, "dist", "server");
    await mkdir(ssrDir, { recursive: true });
    const plugin = prerenderDepsPlugin(pkgDir);

    await plugin.writeBundle({ dir: clientDir });
    await plugin.writeBundle({ dir: ssrDir });

    expect(existsSync(join(clientDir, "node_modules"))).toBe(false);
    expect(existsSync(join(ssrDir, "node_modules"))).toBe(false);
  });

  it("is a no-op when there is no output dir", async () => {
    const { pkgDir } = await isolatedFixture();
    // A `file`-based output has no `dir`; nothing to link against.
    await prerenderDepsPlugin(pkgDir).writeBundle({});
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("does nothing when Blume's deps can't be located", async () => {
    const dir = await prerenderDir();
    const pkgDir = join(root, "lonely", "blume");
    await mkdir(pkgDir, { recursive: true });

    await prerenderDepsPlugin(pkgDir).writeBundle({ dir });

    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });
});
