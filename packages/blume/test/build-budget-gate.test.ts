import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

/**
 * The `--analyze`/`--budget-js`/`--budget-css` gate shared by real and
 * isolated builds: `runClientAssetChecks` must measure the given static dir
 * and exit non-zero on an exceeded budget, and `isolatedStaticDir` must point
 * it at where an isolated build's client assets actually land (the adapter
 * bundle is never surfaced to the project root). Exercised in subprocesses so
 * the command module stays out of the coverage run, like the other command
 * suites.
 */

const PKG_ROOT = join(import.meta.dir, "..");
const BUILD = join(PKG_ROOT, "src", "cli", "commands", "build.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A fake build output: `_astro/` with 2 kB of JS and 2 kB of CSS. */
const distFixture = async (withAssets = true): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-budget-"));
  dirs.push(dir);
  if (withAssets) {
    await mkdir(join(dir, "_astro"), { recursive: true });
    await Promise.all([
      writeFile(join(dir, "_astro", "index.abc123.js"), "x".repeat(2048)),
      writeFile(join(dir, "_astro", "index.abc123.css"), "y".repeat(2048)),
    ]);
  }
  return dir;
};

const runScript = async (
  script: string
): Promise<{ exitCode: number; output: string }> => {
  // `bun test` sets NODE_ENV=test, which lowers consola's default log level
  // and would silence the budget/report lines this suite asserts on.
  const env = { ...process.env };
  delete env.NODE_ENV;
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: PKG_ROOT,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
};

const runGate = (
  staticDir: string,
  args: string
): ReturnType<typeof runScript> =>
  runScript(`
    const { runClientAssetChecks } = await import(${JSON.stringify(BUILD)});
    await runClientAssetChecks(${JSON.stringify(staticDir)}, ${args});
    console.log("GATE_PASSED");
  `);

describe("runClientAssetChecks", () => {
  it("exits non-zero when the JavaScript budget is exceeded", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, `{ "budget-js": "1" }`);
    expect(output).toContain("JavaScript budget exceeded");
    expect(output).not.toContain("GATE_PASSED");
    expect(exitCode).toBe(1);
  });

  it("exits non-zero when the CSS budget is exceeded", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, `{ "budget-css": "1" }`);
    expect(output).toContain("CSS budget exceeded");
    expect(exitCode).toBe(1);
  });

  it("passes budgets under the limit", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(
      dist,
      `{ "budget-css": "100", "budget-js": "100" }`
    );
    expect(output).toContain("JavaScript budget: 2.0 kB / 100 kB");
    expect(output).toContain("CSS budget: 2.0 kB / 100 kB");
    expect(output).toContain("GATE_PASSED");
    expect(exitCode).toBe(0);
  });

  it("reports bundle sizes with --analyze", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, `{ "analyze": true }`);
    expect(output).toContain("Client JavaScript");
    expect(output).toContain("index.abc123.js");
    expect(exitCode).toBe(0);
  });

  it("notes a zero-JS site with --analyze and no assets", async () => {
    const dist = await distFixture(false);
    const { exitCode, output } = await runGate(dist, `{ "analyze": true }`);
    expect(output).toContain("No client JavaScript emitted");
    expect(exitCode).toBe(0);
  });

  it("is a no-op without analyze or budget flags", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, "{}");
    expect(output).not.toContain("budget");
    expect(output).toContain("GATE_PASSED");
    expect(exitCode).toBe(0);
  });
});

describe("isolatedOutputDir", () => {
  it("reports the runtime-local output root per output/adapter", async () => {
    const { exitCode, output } = await runScript(`
      const { isolatedOutputDir } = await import(${JSON.stringify(BUILD)});
      const context = {
        distDir: "/proj/.blume-verify/dist",
        outDir: "/proj/.blume-verify",
      };
      const config = (deployment) => ({ deployment });
      console.log(
        JSON.stringify({
          missingDist: isolatedOutputDir(
            config({ output: "static" }),
            { ...context, distDir: null }
          ),
          nodeServer: isolatedOutputDir(
            config({ adapter: "node", output: "server" }),
            context
          ),
          static: isolatedOutputDir(config({ output: "static" }), context),
          vercelServer: isolatedOutputDir(
            config({ adapter: "vercel", output: "server" }),
            context
          ),
        })
      );
    `);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output);
    // A Vercel server bundle stays inside the runtime dir — the success
    // message must point there, not at the never-populated dist/.
    expect(parsed.vercelServer).toBe("/proj/.blume-verify/.vercel/output");
    expect(parsed.static).toBe("/proj/.blume-verify/dist");
    // Node's standalone output root is dist/ (server + client inside).
    expect(parsed.nodeServer).toBe("/proj/.blume-verify/dist");
    expect(parsed.missingDist).toBe("/proj/.blume-verify/dist");
  });
});

describe("isolatedStaticDir", () => {
  it("resolves the runtime-local static dir per output/adapter", async () => {
    const { exitCode, output } = await runScript(`
      const { isolatedStaticDir } = await import(${JSON.stringify(BUILD)});
      const context = {
        distDir: "/proj/.blume-verify/dist",
        outDir: "/proj/.blume-verify",
      };
      const config = (deployment) => ({ deployment });
      console.log(
        JSON.stringify({
          missingDist: isolatedStaticDir(
            config({ output: "static" }),
            { ...context, distDir: null }
          ),
          nodeServer: isolatedStaticDir(
            config({ adapter: "node", output: "server" }),
            context
          ),
          static: isolatedStaticDir(config({ output: "static" }), context),
          vercelServer: isolatedStaticDir(
            config({ adapter: "vercel", output: "server" }),
            context
          ),
        })
      );
    `);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output);
    // A Vercel server bundle is never surfaced on an isolated build, so its
    // static assets sit inside the runtime dir, not at the project root.
    expect(parsed.vercelServer).toBe(
      "/proj/.blume-verify/.vercel/output/static"
    );
    expect(parsed.static).toBe("/proj/.blume-verify/dist");
    // Node's standalone server serves only Astro's `build.client` dir.
    expect(parsed.nodeServer).toBe("/proj/.blume-verify/dist/client");
    expect(parsed.missingDist).toBe("/proj/.blume-verify/dist");
  });
});
