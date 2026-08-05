import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

/**
 * `emitHeaderFiles` behavior that the `readsHeaderFiles` predicate tests can't
 * see: where the user opt-out is read from and what happens to a `_headers`
 * an adapter already wrote into the output. Both were load-bearing in the
 * Cloudflare server fix — `@astrojs/cloudflare` writes its own `_headers`
 * (an immutable `Cache-Control` for `/_astro/*`) during the build, so reading
 * the opt-out from `dist` skipped silently and the feature never fired.
 * Exercised in subprocesses so the command module stays out of the coverage
 * run, like the other command suites.
 */

const PKG_ROOT = join(import.meta.dir, "..");
const BUILD = join(PKG_ROOT, "src", "cli", "commands", "build.ts");
const SCHEMA = join(PKG_ROOT, "src", "core", "schema.ts");

const ADAPTER_RULE =
  "/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/**
 * A fake project root whose served static dir already holds `seeded` (an
 * adapter-written `_headers`, when given) and whose `public/` holds a user
 * opt-out file when `optOut` is set. Returns the root and the static dir a
 * Cloudflare server build serves (`dist/client`).
 */
const projectFixture = async (options: {
  optOut?: boolean;
  seeded?: string;
}): Promise<{ root: string; staticDir: string }> => {
  const root = await mkdtemp(join(tmpdir(), "blume-headers-"));
  dirs.push(root);
  const staticDir = join(root, "dist", "client");
  await mkdir(staticDir, { recursive: true });
  if (options.seeded) {
    await writeFile(join(staticDir, "_headers"), options.seeded, "utf-8");
  }
  if (options.optOut) {
    await mkdir(join(root, "public"), { recursive: true });
    await writeFile(join(root, "public", "_headers"), "/*\n  X-User: 1\n");
  }
  return { root, staticDir };
};

/** Run `emitHeaderFiles` in a subprocess against a minimal fake project. */
const emit = async (
  root: string,
  staticDir: string,
  deployment: Record<string, unknown>
): Promise<void> => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
      const { emitHeaderFiles } = await import(${JSON.stringify(BUILD)});
      const { blumeConfigSchema } = await import(${JSON.stringify(SCHEMA)});
      const project = {
        config: blumeConfigSchema.parse({
          deployment: ${JSON.stringify(deployment)},
        }),
        context: { root: ${JSON.stringify(root)} },
        manifest: { routes: [{ path: "/docs/intro" }] },
      };
      await emitHeaderFiles(project, ${JSON.stringify(staticDir)});
      `,
    ],
    { cwd: PKG_ROOT, stderr: "pipe", stdout: "ignore" }
  );
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
};

const CLOUDFLARE_SERVER = { adapter: "cloudflare", output: "server" };

describe("emitHeaderFiles", () => {
  it("writes the discovery rules for a Cloudflare server build", async () => {
    const { root, staticDir } = await projectFixture({});
    await emit(root, staticDir, CLOUDFLARE_SERVER);
    const headers = await readFile(join(staticDir, "_headers"), "utf-8");
    expect(headers).toContain("/*.txt\n  Content-Type: text/plain");
    expect(headers).toContain(
      '/\n  Link: </agent-readability.json>; rel="describedby"'
    );
  });

  /**
   * The adapter's rules must survive: `@astrojs/cloudflare` writes its
   * caching rule before this runs, and treating that file as ours to replace
   * would drop it — treating it as a user opt-out (the old `dist` check) is
   * the regression that kept the fix from firing at all.
   */
  it("preserves an adapter-written _headers and appends its own", async () => {
    const { root, staticDir } = await projectFixture({ seeded: ADAPTER_RULE });
    await emit(root, staticDir, CLOUDFLARE_SERVER);
    const headers = await readFile(join(staticDir, "_headers"), "utf-8");
    expect(headers.startsWith(ADAPTER_RULE.trimEnd())).toBe(true);
    expect(headers).toContain(
      '/\n  Link: </agent-readability.json>; rel="describedby"'
    );
  });

  it("treats public/_headers as the opt-out, adapter file or not", async () => {
    const { root, staticDir } = await projectFixture({
      optOut: true,
      seeded: ADAPTER_RULE,
    });
    await emit(root, staticDir, CLOUDFLARE_SERVER);
    expect(await readFile(join(staticDir, "_headers"), "utf-8")).toBe(
      ADAPTER_RULE
    );
  });

  it("writes nothing for a Node server build", async () => {
    const { root, staticDir } = await projectFixture({});
    await emit(root, staticDir, { adapter: "node", output: "server" });
    expect(existsSync(join(staticDir, "_headers"))).toBe(false);
  });
});
