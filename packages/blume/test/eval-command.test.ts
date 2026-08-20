import { afterAll, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

/**
 * `blume eval` end-to-end as a subprocess, with fake `claude`/`codex`
 * executables on PATH so no real agent (or network) is involved.
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

const PROJECT_FILES = {
  "blume.config.ts": 'export default { title: "Test Docs" };',
  "docs/guides/install.md":
    "---\ntitle: Installation\n---\n# Installation\n\nNode 22.12 or newer.\n",
  "docs/index.md": "---\ntitle: Home\n---\n# Home\n\nWelcome.\n",
  "evals.yaml": EVALS,
} satisfies Record<string, string>;

const fixture = async (
  files: Record<string, string> = PROJECT_FILES
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-eval-cmd-"));
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
 * A fake `claude` on PATH. Reader calls (spotted by `--mcp-config`) answer;
 * judge calls reply with the verdict in `$FAKE_VERDICT` (default: pass).
 * Interactive calls (no `-p`) record their prompt for the init/fix tests.
 */
const fakeClaude = async (root: string): Promise<string> => {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const script = `#!/bin/sh
headless=0
reader=0
for arg in "$@"; do
  [ "$arg" = "-p" ] && headless=1
  [ "$arg" = "--mcp-config" ] && reader=1
done
if [ "$headless" = "0" ]; then
  printf '%s' "$1" > "${root}/interactive-prompt.txt"
  exit "\${FAKE_INTERACTIVE_EXIT:-0}"
fi
cat > /dev/null
if [ "$reader" = "1" ]; then
  printf '%s' '{"is_error":false,"result":"The docs say Node 22.12 or newer.","total_cost_usd":0.1}'
elif [ -n "$FAKE_VERDICT" ]; then
  printf '%s' "$FAKE_VERDICT"
else
  printf '%s' '{"is_error":false,"result":"{\\"pass\\": true, \\"score\\": 1, \\"missing\\": []}"}'
fi
`;
  const path = join(bin, "claude");
  await writeFile(path, script);
  await chmod(path, 0o755);
  return bin;
};

const FAIL_VERDICT = JSON.stringify({
  is_error: false,
  result: JSON.stringify({
    missing: ["Node 22.12 or newer"],
    notes: "vague",
    pass: false,
    score: 0.2,
  }),
});

const run = async (
  cwd: string,
  binDir: string | undefined,
  env: Record<string, string>,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
  const path = binDir ? `${binDir}:${process.env.PATH ?? ""}` : "/usr/bin:/bin";
  const proc = Bun.spawn([process.execPath, CLI, "eval", ...args], {
    cwd,
    env: { ...process.env, ...env, PATH: path },
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

describe("blume eval", () => {
  it("passes a healthy run and prints per-question progress", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root);
    const { exitCode, stderr } = await run(root, bin, {});
    expect(exitCode).toBe(0);
    expect(stderr).toContain("blume eval");
    expect(stderr).toContain("install-node-version");
    expect(stderr).toContain("1 passed");
  });

  it("fails the gate and names the page to fix when the docs can't answer", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root);
    const { exitCode, stderr } = await run(root, bin, {
      FAKE_VERDICT: FAIL_VERDICT,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing: Node 22.12 or newer");
    expect(stderr).toContain("fix:");
    expect(stderr).toContain("docs/guides/install.md");
  });

  it("respects --threshold", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root);
    const { exitCode } = await run(
      root,
      bin,
      { FAKE_VERDICT: FAIL_VERDICT },
      "--threshold",
      "0"
    );
    expect(exitCode).toBe(0);
  });

  it("emits machine-readable JSON on stdout and still gates", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root);
    const { exitCode, stdout } = await run(
      root,
      bin,
      { FAKE_VERDICT: FAIL_VERDICT },
      "--json"
    );
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.eval.agent).toBe("claude");
    expect(parsed.eval.counts.fail).toBe(1);
    expect(parsed.eval.results[0].missing).toEqual(["Node 22.12 or newer"]);
    expect(parsed.summary.error).toBe(1);
    expect(parsed.diagnostics[0].code).toBe("BLUME_EVAL_QUESTION_FAILED");
  });

  it("hands a failing run to the agent with --fix", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root);
    const { exitCode, stderr } = await run(
      root,
      bin,
      { FAKE_VERDICT: FAIL_VERDICT },
      "--fix"
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Handing 1 failed question to Claude Code");
    const prompt = await readFile(
      join(root, "interactive-prompt.txt"),
      "utf-8"
    );
    expect(prompt).toContain("blume eval");
    expect(prompt).toContain("report.json");
  });

  it("errors clearly without an evals file", async () => {
    const root = await fixture({
      "blume.config.ts": PROJECT_FILES["blume.config.ts"] ?? "",
      "docs/index.md": PROJECT_FILES["docs/index.md"] ?? "",
    });
    const bin = await fakeClaude(root);
    const { exitCode, stderr } = await run(root, bin, {});
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No evals file found");
    expect(stderr).toContain("blume eval init");
  });

  it("rejects bad flags", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root);

    const agent = await run(root, bin, {}, "--agent", "copilot");
    expect(agent.exitCode).toBe(1);
    expect(agent.stderr).toContain('Invalid --agent "copilot"');

    const exclusive = await run(root, bin, {}, "--json", "--fix");
    expect(exclusive.exitCode).toBe(1);
    expect(exclusive.stderr).toContain("mutually exclusive");

    const threshold = await run(root, bin, {}, "--threshold", "2");
    expect(threshold.exitCode).toBe(1);
    expect(threshold.stderr).toContain("Invalid --threshold");

    const timeout = await run(root, bin, {}, "--timeout", "0");
    expect(timeout.exitCode).toBe(1);
    expect(timeout.stderr).toContain("Invalid --timeout");
  });

  it("suggests the install command when the agent CLI is missing", async () => {
    const root = await fixture();
    const { exitCode, stderr } = await run(root, undefined, {});
    expect(exitCode).toBe(1);
    expect(stderr).toContain("was not found on PATH");
    expect(stderr).toContain("npm install -g @anthropic-ai/claude-code");
  });
});

describe("blume eval init", () => {
  it("refuses to overwrite an existing evals file", async () => {
    const root = await fixture();
    const bin = await fakeClaude(root);
    const { exitCode, stderr } = await run(root, bin, {}, "init");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("hands the drafting prompt to the agent when no file exists", async () => {
    const root = await fixture({
      "blume.config.ts": PROJECT_FILES["blume.config.ts"] ?? "",
      "docs/index.md": PROJECT_FILES["docs/index.md"] ?? "",
    });
    const bin = await fakeClaude(root);
    const { exitCode } = await run(root, bin, {}, "init");
    expect(exitCode).toBe(0);
    const prompt = await readFile(
      join(root, "interactive-prompt.txt"),
      "utf-8"
    );
    expect(prompt).toContain("Draft a starter evals file");
    expect(prompt).toContain("evals.yaml");
  });

  it("propagates a failing interactive session's exit code", async () => {
    const root = await fixture({
      "docs/index.md": PROJECT_FILES["docs/index.md"] ?? "",
    });
    const bin = await fakeClaude(root);
    const { exitCode } = await run(
      root,
      bin,
      { FAKE_INTERACTIVE_EXIT: "3" },
      "init"
    );
    expect(exitCode).toBe(3);
  });
});
