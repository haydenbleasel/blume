import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { envWith, pathWithBin, writeExecutable } from "./process-fixture.ts";

/**
 * A failing `blume eval --verbose` must deliver its whole report through a
 * pipe. The report goes to stderr, and exiting with `process.exit(1)` right
 * after the write cut it off mid-write — the tail, with the summary, never
 * reached the CI log.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-eval-pipe-"));
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

/**
 * Enough answer lines that the --verbose report runs to about 10 MB — far past
 * what a pipe buffers, so a reader that keeps up still loses the tail.
 */
const LINES = 200_000;

/** A fake `claude`: the reader rambles for {@link LINES} lines, the judge fails. */
const fakeClaude = async (root: string): Promise<string> => {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeExecutable(
    bin,
    "claude",
    `const args = process.argv.slice(2);
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const answer = Array.from(
    { length: ${LINES} },
    (_, index) => "The reader is still not sure, line " + index + "."
  ).join("\\n");
  process.stdout.write(
    args.includes("--mcp-config")
      ? JSON.stringify({ is_error: false, result: answer })
      : JSON.stringify({
          is_error: false,
          result: JSON.stringify({ missing: ["Node 22.12 or newer"], pass: false, score: 0 }),
        })
  );
});`
  );
  return bin;
};

describe("blume eval through a pipe", () => {
  it("delivers the whole --verbose report before exiting non-zero", async () => {
    const root = await fixture({
      "blume.config.ts": 'export default { title: "Test Docs" };',
      "docs/guides/install.md":
        "---\ntitle: Installation\n---\n# Installation\n\nNode 22.12 or newer.\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n\nWelcome.\n",
      "evals.yaml": `questions:
  - id: install-node-version
    question: What is the minimum Node.js version?
    expected:
      - Node 22.12 or newer
    routes: /guides/install
`,
    });
    const bin = await fakeClaude(root);
    const proc = Bun.spawn(
      [process.execPath, CLI, "eval", "--agent", "claude", "--verbose"],
      {
        cwd: root,
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

    expect(exitCode).toBe(1);
    // Booleans, not `toContain`: a failure would otherwise print the report.
    expect(stderr.length > 8 * 1024 * 1024).toBe(true);
    expect(stderr.includes(`line ${LINES - 1}.`)).toBe(true);
    expect(stderr.includes("0 passed · 1 failed")).toBe(true);
  }, 60_000);
});
