import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";

import { join } from "pathe";

import { packageRoot } from "../src/core/package-root.ts";

const MODULE = join(packageRoot(), "src/cli/fatal-errors.ts");
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/**
 * Run a script that installs the CLI's handlers in its own process, since
 * they exit it.
 */
const run = async (body: string) => {
  const dir = await mkdtemp(join(tmpdir(), "blume-fatal-errors-"));
  dirs.push(dir);
  const script = join(dir, "child.ts");
  await writeFile(
    script,
    `import { installFatalErrorHandlers, leaveUnhandledRejectionsToAstro } from ${JSON.stringify(MODULE)};\ninstallFatalErrorHandlers();\n${body}\n`,
    "utf-8"
  );
  const proc = Bun.spawn([process.execPath, script], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    code,
    stderr: stripVTControlCharacters(stderr),
    stdout: stripVTControlCharacters(stdout),
  };
};

describe("fatal error handlers", () => {
  it("report an unhandled rejection as an internal error and exit", async () => {
    const { code, stderr, stdout } = await run(`
      Promise.reject(new Error("stranded request"));
      setTimeout(() => console.log("still serving"), 200);
    `);
    expect(code).toBe(1);
    expect(stderr).toContain("BLUME_INTERNAL");
    expect(stderr).toContain("stranded request");
    expect(stdout).not.toContain("still serving");
  });

  it("leave unhandled rejections to Astro's listener once dev is up", async () => {
    // The listener stands in for the one Astro's dev server adds.
    const { code, stderr, stdout } = await run(`
      process.on("unhandledRejection", (reason) => console.log("astro saw: " + reason.message));
      leaveUnhandledRejectionsToAstro();
      Promise.reject(new Error("stranded request"));
      setTimeout(() => console.log("still serving"), 200);
    `);
    expect(code).toBe(0);
    expect(stdout).toContain("astro saw: stranded request");
    expect(stdout).toContain("still serving");
    expect(stderr).not.toContain("BLUME_INTERNAL");
  });

  it("keep exiting on an uncaught exception after leaving rejections", async () => {
    const { code, stderr } = await run(`
      process.on("unhandledRejection", () => {});
      leaveUnhandledRejectionsToAstro();
      setTimeout(() => { throw new Error("broken watcher"); }, 0);
    `);
    expect(code).toBe(1);
    expect(stderr).toContain("BLUME_INTERNAL");
    expect(stderr).toContain("broken watcher");
  });
});
