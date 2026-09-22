import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { pathWithBin, writeExecutable } from "./process-fixture.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];
/** Directory holding a fake `npm` that records its cwd and exits as told. */
let bin: string;

/**
 * Match one line of a `logger.box()` frame. consola draws the box with `│`
 * borders on a terminal, but falls back to ` > ` line prefixes when `CI` is
 * set, so the assertions can't depend on either frame.
 */
const boxLines = (...lines: string[]): RegExp =>
  new RegExp(
    lines
      .map((line) => String.raw`(?:│| >)\s+${line}\s*(?:│)?\n`)
      .join(String.raw`\s*`),
    "u"
  );

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/**
 * Run `blume init` through the public CLI entrypoint with the fake `npm`
 * first on PATH, so the install step never touches the network.
 */
const runInit = async (
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
) => {
  const childEnv = {
    ...process.env,
    ...env,
    PATH: pathWithBin(bin),
  };
  // `bun test` sets NODE_ENV=test, which lowers consola's default log level
  // and silences the install progress and next-steps box asserted on below.
  delete childEnv.NODE_ENV;
  const proc = Bun.spawn([process.execPath, CLI, "init", ...args], {
    cwd,
    env: childEnv,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  );

beforeAll(async () => {
  bin = await tempDir("blume-init-command-bin-");
  await writeExecutable(
    bin,
    "npm",
    `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "installed.marker"), "");
process.stdout.write("fake npm " + process.argv.slice(2).join(" ") + "\\n");
process.exit(Number(process.env.FAKE_NPM_EXIT ?? "0"));`
  );
});

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("blume init", () => {
  it("ignores installed dependencies in a new project", async () => {
    const root = await tempDir("blume-init-command-");
    const project = join(root, "site");

    const { exitCode, stderr } = await runInit(root, [
      project,
      "--yes",
      "--no-install",
    ]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await readFile(join(project, ".gitignore"), "utf-8")).toBe(
      "node_modules/\n.blume/\ndist/\n"
    );
    expect(await exists(join(project, "installed.marker"))).toBe(false);
  });

  it("installs dependencies with the chosen package manager by default", async () => {
    const root = await tempDir("blume-init-command-");

    const { exitCode, stderr, stdout } = await runInit(root, [
      "site",
      "--yes",
      "--package-manager",
      "npm",
    ]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await exists(join(root, "site", "installed.marker"))).toBe(true);
    // The install output streams through, and the next steps no longer tell
    // the user to install what has just been installed.
    expect(stdout).toContain("fake npm install");
    expect(stdout).toContain("Installed dependencies");
    expect(stdout).toContain("cd site");
    expect(stdout).toContain("npm run dev");
    // The box frames each line, so match the bare command, not the line.
    expect(stdout).not.toMatch(boxLines("npm install"));
  });

  it("keeps the scaffold and prints the retry command when the install fails", async () => {
    const root = await tempDir("blume-init-command-");

    const { exitCode, stderr, stdout } = await runInit(
      root,
      ["site", "--yes", "--package-manager", "npm"],
      { FAKE_NPM_EXIT: "3" }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("npm install exited with code 3");
    expect(stdout).toContain(
      "Project created successfully, but dependency installation failed."
    );
    expect(stdout).toMatch(boxLines("cd site", "npm install"));
    expect(await exists(join(root, "site", "package.json"))).toBe(true);
    expect(await exists(join(root, "site", "blume.config.ts"))).toBe(true);
  });

  it("skips the install when package.json already exists", async () => {
    const root = await tempDir("blume-init-command-");
    await writeFile(join(root, "package.json"), '{ "name": "existing" }\n');

    const { exitCode, stderr, stdout } = await runInit(root, [
      "--yes",
      "--package-manager",
      "npm",
    ]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await exists(join(root, "installed.marker"))).toBe(false);
    expect(stdout).not.toContain("Installing dependencies");
  });
});
