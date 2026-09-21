import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join, resolve } from "pathe";

import { cliBundleOptions } from "../scripts/cli-bundle.ts";

const PKG_ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];

// The bundle is built inside the package (not `os.tmpdir()`) so Node can
// resolve its externalized dependencies from `packages/blume/node_modules`
// when the entry is executed. The `blume-*` prefix keeps it out of coverage.
let outdir = "";

beforeAll(async () => {
  outdir = await mkdtemp(join(PKG_ROOT, "blume-cli-bundle-"));
  dirs.push(outdir);
  const result = await Bun.build(cliBundleOptions(outdir));
  expect(result.logs.map((log) => log.message)).toEqual([]);
  expect(result.success).toBe(true);
});

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

// Static `import` statements as Bun emits them at the top of a chunk:
// `import { a } from "./x.js"`, multi-line bindings, and bare `import"./x.js"`.
// Dynamic `import(...)` calls never start a line, so `^` skips them.
const STATIC_IMPORT = /^import\s*(?:[^;]*?\bfrom\s*)?"(?<specifier>[^"]+)"/gmu;

/**
 * Walk the entry's *static* import graph (following relative chunks only) and
 * return the bare package specifiers it reaches — what Node resolves and
 * evaluates before the entry runs, regardless of which command was asked for.
 */
const eagerExternals = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const match of readFileSync(file, "utf-8").matchAll(STATIC_IMPORT)) {
      const specifier = match.groups?.specifier ?? "";
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
      } else {
        externals.add(specifier);
      }
    }
  }
  return externals;
};

// Packages that belong to individual commands. Any of these in the entry's
// static graph means a command's dependency graph leaked back into startup.
const COMMAND_ONLY = ["astro", "@astrojs/", "@modelcontextprotocol/", "vite"];

// consola also reads NODE_ENV / TEST / CI / DEBUG at startup, and `bun test`
// exports NODE_ENV=test to children — which alone silences it. Hand the child a
// scrubbed environment so only the project `.env` is in play.
const LOGGER_ENV = new Set([
  "CI",
  "CONSOLA_LEVEL",
  "DEBUG",
  "NODE_ENV",
  "TEST",
]);

const runNode = async (cwd: string, ...args: string[]) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !LOGGER_ENV.has(key))
  );
  const proc = Bun.spawn(["node", join(outdir, "cli", "index.js"), ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

describe("CLI bundle", () => {
  it("keeps the whole bundle under cli/ and every command's dependencies out of the entry's static imports", () => {
    const outputs = [...new Bun.Glob("**/*").scanSync({ cwd: outdir })].map(
      (file) => file.replaceAll("\\", "/")
    );
    expect(outputs).toContain("cli/index.js");
    expect(outputs.filter((file) => !file.startsWith("cli/"))).toEqual([]);
    expect(
      outputs.filter((file) => /^cli\/chunk-.*\.js$/u.test(file)).length
    ).toBeGreaterThan(1);

    const externals = eagerExternals(join(outdir, "cli", "index.js"));
    const leaked = [...externals].filter((specifier) =>
      COMMAND_ONLY.some((prefix) => specifier.startsWith(prefix))
    );
    expect(leaked).toEqual([]);
    // The logger must evaluate before `.env` is applied (see cli/index.ts).
    expect(externals).toContain("consola");
  });

  it("keeps a project .env from changing the logger's level under Node", async () => {
    // consola reads CONSOLA_LEVEL when its module evaluates. With commands
    // loaded lazily, the entry has to import the logger itself before
    // `loadEnvFiles`, or a project `.env` silences every command's output.
    // (Bun auto-loads `.env` before any module runs, so only Node shows it.)
    const project = await mkdtemp(join(tmpdir(), "blume-cli-bundle-env-"));
    dirs.push(project);
    await writeFile(join(project, ".env"), "CONSOLA_LEVEL=0\n");
    const result = await runNode(project, "version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Versioning is not configured"
    );
  }, 30_000);
});
