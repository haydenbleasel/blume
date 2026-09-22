import { describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput, ResolvedConfig } from "../src/core/schema.ts";
import type { ProjectContext } from "../src/core/types.ts";
import {
  deployOutputDir,
  deployStaticDir,
  readsHeaderFiles,
  surfaceAdapterOutput,
} from "../src/deploy/adapter-output.ts";
import {
  cloudflare,
  netlify,
  node,
  vercel,
} from "../src/deploy/adapters/index.ts";

const config = (
  deployment: BlumeConfigInput["deployment"] = {}
): ResolvedConfig => blumeConfigSchema.parse({ deployment });

const context = (root: string): ProjectContext => ({
  componentsFile: null,
  configFile: null,
  contentRoot: join(root, "content"),
  distDir: join(root, "dist"),
  outDir: join(root, ".blume"),
  pagesRoot: null,
  root,
  themeFile: null,
});

/** A `blume build --isolated` context: the runtime and its dist relocated. */
const isolated = (root: string): ProjectContext => ({
  ...context(root),
  distDir: join(root, ".blume-verify", "dist"),
  outDir: join(root, ".blume-verify"),
});

/**
 * Write a fake Netlify Frameworks API bundle under `<root>/.blume/.netlify/v1`.
 * Netlify is the surfacing machinery's only caller — Vercel is handed the real
 * project root and writes straight there (see `withAdapterRoot`).
 */
const seed = async (root: string): Promise<void> => {
  const src = join(root, ".blume", ".netlify", "v1");
  await mkdir(join(src, "functions"), { recursive: true });
  await writeFile(join(src, "config.json"), '{"version":1}', "utf-8");
};

/** Surface a bundle in a Node process, the runtime `blume build` runs in. */
const surfaceUnderNode = async (root: string): Promise<void> => {
  const source = new URL("../src/deploy/adapter-output.ts", import.meta.url)
    .href;
  const proc = Bun.spawn(
    [
      "node",
      // Required below Node 22.18, where type stripping is not yet on by
      // default; accepted (and redundant) after.
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `const { surfaceAdapterOutput } = await import(${JSON.stringify(source)});
       await surfaceAdapterOutput(
         { deployment: { kind: "netlify", options: { output: "server" } } },
         { outDir: ${JSON.stringify(join(root, ".blume"))}, root: ${JSON.stringify(root)} }
       );`,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`surfaceAdapterOutput failed under node: ${stderr}`);
  }
};

describe("deployStaticDir", () => {
  it("serves .vercel/output/static for a Vercel server build", () => {
    const ctx = context("/proj");
    expect(deployStaticDir(config(vercel()), ctx)).toBe(
      "/proj/.vercel/output/static"
    );
  });

  it("serves dist/ for a static build", () => {
    const ctx = context("/proj");
    expect(deployStaticDir(config(), ctx)).toBe("/proj/dist");
  });

  it("serves dist/ for server adapters whose platform serves dist/", () => {
    const ctx = context("/proj");
    expect(deployStaticDir(config(netlify()), ctx)).toBe("/proj/dist");
  });

  it("serves dist/client/ for a Node server build", () => {
    // The @astrojs/node standalone server's static handler reads only
    // Astro's `build.client` dir (`dist/client/`), never `dist/` itself.
    const ctx = context("/proj");
    expect(deployStaticDir(config(node()), ctx)).toBe("/proj/dist/client");
  });

  it("serves dist/client/ for a Cloudflare server build", () => {
    // `@astrojs/cloudflare` declares `preserveBuildClientDir: true`, keeping
    // Astro's `dist/client` + `dist/server` split, and points the ASSETS
    // binding in the `dist/server/wrangler.json` it generates at `../client`.
    // Artifacts written to `dist/` itself are above what the Worker serves.
    const ctx = context("/proj");
    expect(deployStaticDir(config(cloudflare()), ctx)).toBe(
      "/proj/dist/client"
    );
  });

  it("serves dist/ for a Cloudflare static build", () => {
    // A static build has no server dir to split against, so the `outDir` root
    // is what ships — unchanged by the server-build fix above.
    const ctx = context("/proj");
    expect(deployStaticDir(config(cloudflare({ output: "static" })), ctx)).toBe(
      "/proj/dist"
    );
  });

  it("falls back to <root>/dist when the context has no distDir", () => {
    // Exercises the "no distDir" fallback; distDir is optional (string), so
    // it must be undefined rather than null.
    // oxlint-disable-next-line sonarjs/no-undefined-assignment
    const ctx: ProjectContext = { ...context("/proj"), distDir: undefined };
    expect(deployStaticDir(config(), ctx)).toBe("/proj/dist");
  });

  it("keeps an isolated build's static dir inside the relocated runtime", () => {
    // A Vercel server bundle is never surfaced on an isolated build, so its
    // static assets sit inside the runtime dir, not at the project root —
    // where a previous real build's assets (or nothing) would be measured.
    const ctx = isolated("/proj");
    expect(deployStaticDir(config(vercel()), ctx)).toBe(
      "/proj/.blume-verify/.vercel/output/static"
    );
    expect(deployStaticDir(config(), ctx)).toBe("/proj/.blume-verify/dist");
    expect(deployStaticDir(config(node()), ctx)).toBe(
      "/proj/.blume-verify/dist/client"
    );
    expect(deployStaticDir(config(cloudflare()), ctx)).toBe(
      "/proj/.blume-verify/dist/client"
    );
    expect(deployStaticDir(config(cloudflare({ output: "static" })), ctx)).toBe(
      "/proj/.blume-verify/dist"
    );
  });
});

describe("deployOutputDir", () => {
  it("reports where each build's output lands", () => {
    const ctx = context("/proj");
    expect(deployOutputDir(config(), ctx)).toBe("/proj/dist");
    // Node's standalone output root is dist/ (server + client inside).
    expect(deployOutputDir(config(node()), ctx)).toBe("/proj/dist");
    expect(deployOutputDir(config(vercel()), ctx)).toBe("/proj/.vercel/output");
  });

  it("keeps an isolated build's output inside the relocated runtime", () => {
    // The success message must point at the Vercel bundle inside the runtime
    // dir, not at the never-populated dist/.
    const ctx = isolated("/proj");
    expect(deployOutputDir(config(vercel()), ctx)).toBe(
      "/proj/.blume-verify/.vercel/output"
    );
    expect(deployOutputDir(config(), ctx)).toBe("/proj/.blume-verify/dist");
    expect(deployOutputDir(config(node()), ctx)).toBe(
      "/proj/.blume-verify/dist"
    );
  });
});

describe("surfaceAdapterOutput", () => {
  it("never moves a Vercel bundle — the adapter writes to the project root", async () => {
    // Vercel is shown the real project root up front (`withAdapterRoot`), because
    // its `@vercel/nft` trace is rooted there too and tracing from `.blume` drops
    // the function's chunks and node_modules. So its Build Output tree is already
    // at `<root>/.vercel/output` and there is nothing to surface.
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    await mkdir(join(root, ".blume", ".vercel", "output"), { recursive: true });

    expect(await surfaceAdapterOutput(config(vercel()), context(root))).toEqual(
      { moved: false }
    );
  });

  it("moves only .netlify/v1, preserving netlify link state", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    await mkdir(join(root, ".blume", ".netlify", "v1"), { recursive: true });
    await writeFile(
      join(root, ".blume", ".netlify", "v1", "config.json"),
      "{}",
      "utf-8"
    );
    // A `netlify link`-ed state.json must survive the move.
    await mkdir(join(root, ".netlify"), { recursive: true });
    await writeFile(
      join(root, ".netlify", "state.json"),
      '{"siteId":"abc"}',
      "utf-8"
    );

    const result = await surfaceAdapterOutput(config(netlify()), context(root));

    expect(result).toEqual({
      from: join(root, ".blume", ".netlify", "v1"),
      moved: true,
      to: join(root, ".netlify", "v1"),
    });
    expect(existsSync(join(root, ".netlify", "v1", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".blume", ".netlify", "v1"))).toBe(false);
    // The linked state.json is untouched — only `.netlify/v1` moved.
    expect(await readFile(join(root, ".netlify", "state.json"), "utf-8")).toBe(
      '{"siteId":"abc"}'
    );
  });

  it("keeps a traced dependency's symlink resolvable after the move", async () => {
    // An adapter traces each dependency into the function bundle as a *relative*
    // symlink (a package's `node_modules` entry pointing at the isolated
    // linker's store copy). Node's `fs.cp` resolves such a target against the
    // source unless told not to, anchoring it in the `.blume` dir this move goes
    // on to delete — the deployed function then dies on its first external
    // import. Run under Node because that is the runtime the CLI's shebang
    // picks, and the only one that rewrites targets: Bun's `fs.cp` (which runs
    // this suite) is verbatim either way, so an in-process call proves nothing.
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    await seed(root);
    const fn = join(root, ".blume", ".netlify", "v1", "functions", "f");
    // A relative directory symlink needs Windows symlink privilege. A junction
    // is the permission-independent equivalent there, so keep its target
    // outside `.blume` (the tree that is deleted after the move). Recreating
    // it verbatim needs that same privilege, which is where the copy falls
    // back to copying through the link.
    const store =
      process.platform === "win32"
        ? join(root, "store", "dep")
        : join(fn, "node_modules", ".store", "dep");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "index.js"), "export default 1;", "utf-8");
    const linkTarget = process.platform === "win32" ? store : "./.store/dep";
    await mkdir(join(fn, "node_modules"), { recursive: true });
    await symlink(
      linkTarget,
      join(fn, "node_modules", "dep"),
      process.platform === "win32" ? "junction" : "dir"
    );

    await surfaceUnderNode(root);

    const moved = join(root, ".netlify", "v1", "functions", "f");
    // The preserved link on POSIX, or the dereferenced directory on Windows,
    // must both resolve to the package where the bundle landed.
    expect(
      await readFile(join(moved, "node_modules", "dep", "index.js"), "utf-8")
    ).toBe("export default 1;");
    if (process.platform !== "win32") {
      // The link still names its target relatively — self-contained wherever
      // the bundle deploys to — rather than being copied through.
      expect(await readlink(join(moved, "node_modules", "dep"))).toBe(
        "./.store/dep"
      );
    }
  });

  it("copies through the links when the platform refuses to recreate them", async () => {
    // Windows without symlink privilege answers EPERM to the verbatim copy;
    // the bundle is then copied with links dereferenced so it still runs. On
    // POSIX the verbatim copy never fails that way, so it is made to here.
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    await seed(root);
    const fn = join(root, ".blume", ".netlify", "v1", "functions", "f");
    const store = join(fn, "node_modules", ".store", "dep");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "index.js"), "export default 1;", "utf-8");
    await symlink("./.store/dep", join(fn, "node_modules", "dep"), "dir");
    const realCp = fsPromises.cp;
    const attempts: boolean[] = [];
    const spy = spyOn(fsPromises, "cp").mockImplementation(
      (from, to, options) => {
        attempts.push(options?.dereference === true);
        return options?.verbatimSymlinks
          ? Promise.reject(
              Object.assign(
                new Error("EPERM: operation not permitted, symlink"),
                {
                  code: "EPERM",
                }
              )
            )
          : realCp(from, to, options);
      }
    );
    try {
      await surfaceAdapterOutput(config(netlify()), context(root));
    } finally {
      spy.mockRestore();
    }

    expect(attempts).toEqual([false, true]);
    const moved = join(root, ".netlify", "v1", "functions", "f");
    const dep = join(moved, "node_modules", "dep");
    const stats = await lstat(dep);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(await readFile(join(dep, "index.js"), "utf-8")).toBe(
      "export default 1;"
    );
    expect(existsSync(fn)).toBe(false);
  });

  it("surfaces any other copy failure instead of copying through links", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    await seed(root);
    let attempts = 0;
    const spy = spyOn(fsPromises, "cp").mockImplementation(() => {
      attempts += 1;
      return Promise.reject(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        })
      );
    });
    try {
      await expect(
        surfaceAdapterOutput(config(netlify()), context(root))
      ).rejects.toThrow("EACCES");
    } finally {
      spy.mockRestore();
    }
    expect(attempts).toBe(1);
    // The bundle is still where it was, for the next attempt.
    expect(existsSync(join(root, ".blume", ".netlify", "v1"))).toBe(true);
  });

  it("replaces a stale destination bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    await seed(root);
    await mkdir(join(root, ".netlify", "v1"), { recursive: true });
    await writeFile(join(root, ".netlify", "v1", "stale.txt"), "old", "utf-8");

    await surfaceAdapterOutput(config(netlify()), context(root));

    expect(existsSync(join(root, ".netlify", "v1", "stale.txt"))).toBe(false);
    expect(existsSync(join(root, ".netlify", "v1", "config.json"))).toBe(true);
  });

  it("is a no-op for a static build", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    await seed(root);
    expect(await surfaceAdapterOutput(config(), context(root))).toEqual({
      moved: false,
    });
    // A static build on Netlify has no bundle to move either.
    expect(
      await surfaceAdapterOutput(
        config(netlify({ output: "static" })),
        context(root)
      )
    ).toEqual({ moved: false });
    expect(existsSync(join(root, ".netlify", "v1"))).toBe(false);
  });

  it("is a no-op for adapters that emit into dist/", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    expect(await surfaceAdapterOutput(config(node()), context(root))).toEqual({
      moved: false,
    });
  });

  it("is a no-op when the expected output is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-surface-"));
    expect(
      await surfaceAdapterOutput(config(netlify()), context(root))
    ).toEqual({ moved: false });
  });
});

describe("readsHeaderFiles", () => {
  it("is true for a static build with no named host", () => {
    // Nothing is known about where dist/ ends up, so the file is written for
    // the hosts that read it; the rest ignore it harmlessly.
    expect(readsHeaderFiles(config().deployment)).toBe(true);
  });

  it("is true for a static build on the hosts that read the file", () => {
    for (const adapter of [netlify, cloudflare]) {
      expect(
        readsHeaderFiles(config(adapter({ output: "static" })).deployment)
      ).toBe(true);
    }
  });

  it("is false for a static build on hosts that never read the file", () => {
    // Vercel's headers ride the routing config; Node has no static host at
    // all — writing the file for either would report a rule nothing applies.
    for (const adapter of [vercel, node]) {
      expect(
        readsHeaderFiles(config(adapter({ output: "static" })).deployment)
      ).toBe(false);
    }
  });

  /**
   * The regression this fixes. A Cloudflare server build serves `dist/client`
   * through the Worker's ASSETS binding, which honors `_headers` — so skipping
   * the file left the homepage with no agent-discovery `Link` header and the
   * well-known files with no registered media type.
   */
  it("is true for a Cloudflare server build", () => {
    expect(readsHeaderFiles(config(cloudflare()).deployment)).toBe(true);
  });

  it("is false for a Node server build, whose static handler ignores the file", () => {
    expect(readsHeaderFiles(config(node()).deployment)).toBe(false);
  });

  it("is false for a Vercel server build, which uses the routing config", () => {
    expect(readsHeaderFiles(config(vercel()).deployment)).toBe(false);
  });

  it("is false for a Netlify server build, whose bundle never applied it", () => {
    expect(readsHeaderFiles(config(netlify()).deployment)).toBe(false);
  });
});
