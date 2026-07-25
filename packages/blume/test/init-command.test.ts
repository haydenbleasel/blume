import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("blume init", () => {
  it("ignores installed dependencies in a new project", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-init-command-"));
    dirs.push(root);
    const project = join(root, "site");

    // Scaffold a project through the public CLI entrypoint.
    const proc = Bun.spawn([process.execPath, CLI, "init", project, "--yes"], {
      cwd: root,
      stderr: "pipe",
      stdout: "ignore",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await readFile(join(project, ".gitignore"), "utf-8")).toBe(
      "node_modules/\n.blume/\ndist/\n"
    );
  });
});
