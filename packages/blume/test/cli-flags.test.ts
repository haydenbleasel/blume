import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-cli-flags-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const run = async (
  root: string,
  args: string[]
): Promise<{ exitCode: number; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    env: { ...process.env, CONSOLA_LEVEL: "3" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr };
};

const PAGE = { "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n" };

describe("unknown flags", () => {
  it("stops a typo'd build before it builds anything", async () => {
    const root = await makeProject(PAGE);
    const { exitCode, stderr } = await run(root, ["build", "--isolatd"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("BLUME_UNKNOWN_OPTION");
    expect(stderr).toContain(
      "blume build doesn't know the option --isolatd (did you mean --isolated?)."
    );
    expect(stderr).toContain("--isolated");
    expect(existsSync(join(root, ".blume"))).toBe(false);
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("keeps a mistyped negation negated, and lists on-by-default switches as --no-", async () => {
    const root = await makeProject(PAGE);
    const { exitCode, stderr } = await run(root, ["build", "--no-strcit"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("(did you mean --no-strict?)");
    // `blume build` is strict unless told otherwise, so the list names the
    // switch that does something.
    expect(stderr).toContain("--no-strict");
    expect(stderr).not.toContain(", --strict,");
    expect(existsSync(join(root, ".blume"))).toBe(false);
  });

  it("names the flags a command takes", async () => {
    const root = await makeProject(PAGE);
    const { exitCode, stderr } = await run(root, ["validate", "--strcit"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("(did you mean --strict?)");
    expect(stderr).toContain(
      "It takes --external, --ignore, --json, --strict."
    );
  });
});

describe("blume preview", () => {
  it("asks for a build when only the dev runtime exists", async () => {
    const root = await makeProject({
      ...PAGE,
      ".blume/astro.config.mjs": "export default {};\n",
    });
    const { exitCode, stderr } = await run(root, ["preview"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No build found. Run `blume build` first.");
    expect(stderr).not.toContain("does not exist");
  });
});

describe("strict mode advice", () => {
  it("tells an opt-in strict command to drop --strict", async () => {
    const root = await makeProject({
      "docs/index.mdx": "---\ntitle: 42\nnope: true\n---\n# Home\n",
    });
    const { exitCode, stderr } = await run(root, [
      "dev",
      "--strict",
      "--port",
      "4861",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("drop --strict to continue despite them");
    expect(stderr).not.toContain("--no-strict");
  }, 60_000);
});
