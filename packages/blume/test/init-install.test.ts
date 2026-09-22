import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { installDependencies } from "../src/cli/init/install.ts";
import { pathWithBin, writeExecutable } from "./process-fixture.ts";

/**
 * A fake `npm` on PATH: writes a marker in its cwd, echoes, and exits with
 * the code the test asks for through the FAKE_NPM_EXIT environment variable.
 * It goes first on the real PATH rather than replacing it: the script runs
 * through a `node` shebang (POSIX) or a `.cmd` shim (Windows), so the
 * runtime must stay findable.
 */
let bin: string;
let project: string;
const originalPath = process.env.PATH;

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "blume-init-install-bin-"));
  project = await mkdtemp(join(tmpdir(), "blume-init-install-project-"));
  await writeExecutable(
    bin,
    "npm",
    `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "installed.marker"), "");
process.stdout.write("fake npm " + process.argv.slice(2).join(" ") + "\\n");
process.stderr.write("fake warning\\n");
process.exit(Number(process.env.FAKE_NPM_EXIT ?? "0"));`
  );
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_NPM_EXIT;
});

afterAll(async () => {
  await Promise.all([
    rm(bin, { force: true, recursive: true }),
    rm(project, { force: true, recursive: true }),
  ]);
});

describe("installDependencies", () => {
  it("runs the package manager's install in the project root", async () => {
    process.env.PATH = pathWithBin(bin);
    const outcome = await installDependencies(project, "npm", { quiet: true });
    expect(outcome).toEqual({ command: "npm install" });
    const marker = await stat(join(project, "installed.marker"));
    expect(marker.isFile()).toBe(true);
  });

  it("streams output when not quiet", async () => {
    process.env.PATH = pathWithBin(bin);
    const outcome = await installDependencies(project, "npm", {
      quiet: false,
    });
    expect(outcome).toEqual({ command: "npm install" });
  });

  it("reports a non-zero exit with the captured output", async () => {
    process.env.PATH = pathWithBin(bin);
    process.env.FAKE_NPM_EXIT = "7";
    const outcome = await installDependencies(project, "npm", { quiet: true });
    expect(outcome).toEqual({
      command: "npm install",
      failure: "npm install exited with code 7\nfake npm install\nfake warning",
    });
  });

  it("reports a missing package manager instead of throwing", async () => {
    process.env.PATH = project;
    const outcome = await installDependencies(project, "npm", { quiet: true });
    expect(outcome.command).toBe("npm install");
    // Node reports `spawn npm ENOENT`; Bun words it differently, but both name the binary.
    expect(outcome.failure).toContain("npm");
  });
});
