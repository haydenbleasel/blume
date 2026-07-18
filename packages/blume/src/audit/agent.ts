import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { reportJson } from "./report.ts";
import type { AuditResult } from "./run.ts";

/** A coding agent CLI the audit can hand its findings to (`--claude`, `--codex`). */
export interface AgentCli {
  /** The executable to look up on PATH. */
  bin: string;
  /** How to install it, shown when the executable is missing. */
  install: string;
  /** Display name for messages. */
  name: string;
}

export type AgentKind = "claude" | "codex";

export const AGENTS: Record<AgentKind, AgentCli> = {
  claude: {
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    name: "Claude Code",
  },
  codex: {
    bin: "codex",
    install: "npm install -g @openai/codex",
    name: "Codex",
  },
};

/**
 * Write the full JSON report where the agent can read it. A file rather than
 * inline prompt text: a large site's report can exceed the platform's argv
 * limit, and the JSON already carries every finding untruncated — the terminal
 * report previews three pages per check, the file never does.
 */
export const writeAgentReport = async (
  result: AuditResult,
  root: string
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-audit-"));
  const path = join(dir, "report.json");
  await writeFile(path, reportJson(result, root));
  return path;
};

/** The handoff prompt: where the report is, how to read it, and the ground rules. */
export const fixPrompt = (reportPath: string): string =>
  `Fix the issues found by \`blume audit\` in this project.

The full audit report is at ${reportPath}. It is JSON: each entry in \`diagnostics\` is one finding, with the check \`code\`, a \`message\` explaining what is wrong, the affected page \`url\`, the source \`file\` to edit (relative to the current directory, with a \`line\` when the finding points at a specific front matter key), and a \`suggestion\` describing the fix.

Work through every finding:
1. Read the report and group the findings by \`file\`.
2. Apply each finding's \`suggestion\` by editing the named source file — most fixes are front matter edits at the cited line.
3. Never fix a finding by deleting a page, removing content, or hiding it from the audit; if a finding genuinely needs a human decision, leave it and say so in your summary.

When you are done, run \`blume build\` and then \`blume audit\` to verify, and repeat until the audit reports no issues.`;

/**
 * Run the agent CLI interactively with the handoff prompt, inheriting the
 * terminal so the user watches and steers the fixes rather than granting a
 * headless process blanket write access. Resolves with the agent's exit code;
 * rejects when the executable isn't on PATH.
 */
export const launchAgent = (bin: string, prompt: string): Promise<number> =>
  // oxlint-disable-next-line promise/avoid-new -- adapt spawn's event callbacks
  new Promise((resolve, reject) => {
    const child = spawn(bin, [prompt], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
