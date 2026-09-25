import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

/**
 * The `--analyze`/`--budget-js`/`--budget-css` gate shared by real and
 * isolated builds: `runClientAssetChecks` must measure the given static dir
 * and exit non-zero on an exceeded budget. Where an isolated build's client
 * assets land is `deployStaticDir` with a relocated context, covered in
 * adapter-output.test.ts. Exercised in subprocesses so the command module
 * stays out of the coverage run, like the other command suites.
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

// Each case cold-starts `bun -e` and imports the whole build command, which
// usually takes 1-2s on the Windows runner but has spiked past Bun's 5s
// default, so every case gets an explicit timeout like the other command
// suites.
describe("runClientAssetChecks", () => {
  it("exits non-zero when the JavaScript budget is exceeded", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, `{ "budget-js": "1" }`);
    expect(output).toContain("JavaScript budget exceeded");
    expect(output).not.toContain("GATE_PASSED");
    expect(exitCode).toBe(1);
  }, 30_000);

  it("exits non-zero when the CSS budget is exceeded", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, `{ "budget-css": "1" }`);
    expect(output).toContain("CSS budget exceeded");
    expect(exitCode).toBe(1);
  }, 30_000);

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
  }, 30_000);

  it("reports bundle sizes with --analyze", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, `{ "analyze": true }`);
    expect(output).toContain("Client JavaScript");
    expect(output).toContain("index.abc123.js");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("notes a zero-JS site with --analyze and no assets", async () => {
    const dist = await distFixture(false);
    const { exitCode, output } = await runGate(dist, `{ "analyze": true }`);
    expect(output).toContain("No client JavaScript emitted");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("is a no-op without analyze or budget flags", async () => {
    const dist = await distFixture();
    const { exitCode, output } = await runGate(dist, "{}");
    expect(output).not.toContain("budget");
    expect(output).toContain("GATE_PASSED");
    expect(exitCode).toBe(0);
  }, 30_000);
});
