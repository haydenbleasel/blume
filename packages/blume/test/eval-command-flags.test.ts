import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { envWith, pathWithBin, writeExecutable } from "./process-fixture.ts";

/**
 * `blume eval` flag edge cases, as a subprocess with a fake `claude` on PATH:
 * an empty `--threshold` must not switch the gate off, a `--timeout` longer
 * than a timer can hold is refused, and an absolute `--file` is used as given.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const EVALS = `questions:
  - id: install-node-version
    question: What is the minimum Node.js version?
    expected:
      - Node 22.12 or newer
    routes: /guides/install
`;

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await tempDir("blume-eval-flags-");
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const PROJECT = {
  "blume.config.ts": 'export default { title: "Test Docs" };',
  "docs/guides/install.md":
    "---\ntitle: Installation\n---\n# Installation\n\nNode 22.12 or newer.\n",
  "docs/index.md": "---\ntitle: Home\n---\n# Home\n\nWelcome.\n",
};

/**
 * A fake `claude`: the reader answers, the judge fails every question, and an
 * interactive session (no `-p`) records that it was launched.
 */
const fakeClaude = async (root: string): Promise<string> => {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeExecutable(
    bin,
    "claude",
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (!args.includes("-p")) {
  fs.writeFileSync(path.join(${JSON.stringify(root)}, "launched.txt"), "yes");
  process.exit(0);
}
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const reader = args.includes("--mcp-config");
  process.stdout.write(
    reader
      ? JSON.stringify({ is_error: false, result: "No idea." })
      : JSON.stringify({
          is_error: false,
          result: JSON.stringify({ missing: ["Node 22.12 or newer"], pass: false, score: 0 }),
        })
  );
});`
  );
  return bin;
};

const run = async (
  cwd: string,
  bin: string,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string }> => {
  const proc = Bun.spawn(
    [process.execPath, CLI, "eval", "--agent", "claude", ...args],
    {
      cwd,
      env: envWith({ PATH: pathWithBin(bin) }),
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr };
};

describe("blume eval flags", () => {
  it("rejects an empty --threshold instead of reading it as 0", async () => {
    const root = await fixture({ ...PROJECT, "evals.yaml": EVALS });
    const bin = await fakeClaude(root);

    // `--threshold "$EVAL_THRESHOLD"` with the variable unset.
    const empty = await run(root, bin, "--threshold", "");
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain('Invalid --threshold ""');

    // A bare `--threshold` at the end of the line.
    const bare = await run(root, bin, "--threshold");
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("Invalid --threshold");
  }, 30_000);

  it("refuses a --timeout longer than a timer can hold", async () => {
    const root = await fixture({ ...PROJECT, "evals.yaml": EVALS });
    const bin = await fakeClaude(root);
    const { exitCode, stderr } = await run(root, bin, "--timeout", "3000000");
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --timeout "3000000" (at most 2147483');
  });

  it("reads an absolute --file as given", async () => {
    const root = await fixture(PROJECT);
    const bin = await fakeClaude(root);
    const elsewhere = await tempDir("blume-eval-flags-file-");
    const file = join(elsewhere, "evals.yaml");
    await writeFile(file, EVALS);

    const { exitCode, stderr } = await run(
      root,
      bin,
      "--file",
      file,
      "--threshold",
      "0"
    );
    expect(stderr).not.toContain("No evals file found");
    expect(stderr).toContain("install-node-version");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("guards an absolute --file for init", async () => {
    const root = await fixture(PROJECT);
    const bin = await fakeClaude(root);
    const elsewhere = await tempDir("blume-eval-flags-init-");
    const file = join(elsewhere, "evals.yaml");
    await writeFile(file, EVALS);

    const { exitCode, stderr } = await run(root, bin, "init", "--file", file);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
    expect(existsSync(join(root, "launched.txt"))).toBe(false);
  });
});
