import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { join } from "pathe";
import { z } from "zod";

import type { AgentKind } from "../audit/agent.ts";

/** How long the SIGTERM on timeout gets to work before SIGKILL follows. */
const KILL_GRACE_MS = 5000;

/** The MCP tools a reader run may use — nothing else. */
export const MCP_TOOL_NAMES = [
  "search_docs",
  "get_page",
  "list_pages",
  "get_navigation",
] as const;

/** The MCP server name in the generated config; tool ids derive from it. */
const MCP_SERVER_NAME = "docs";

/**
 * Claude Code built-ins that would let the agent escape the docs-only
 * sandbox: the reader must not read the repo, run commands, or search the
 * web — it sees the documentation the way a stranger does, through MCP.
 */
export const DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

/** The captured outcome of one headless agent invocation. */
export interface HeadlessResult {
  code: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface HeadlessOptions {
  cwd: string;
  platform?: NodeJS.Platform;
  prompt: string;
  timeoutMs: number;
}

/**
 * Run an agent CLI headlessly: prompt over stdin (dodging argv limits and
 * cmd.exe newline quoting alike), stdout and stderr captured, SIGTERM at the
 * deadline with a SIGKILL follow-up. Resolves with the captured result;
 * rejects only when the executable cannot be spawned at all (ENOENT).
 */
export const runAgentHeadless = (
  bin: string,
  args: string[],
  options: HeadlessOptions
): Promise<HeadlessResult> =>
  // oxlint-disable-next-line promise/avoid-new -- adapt spawn's event callbacks
  new Promise((resolve, reject) => {
    const platform = options.platform ?? process.platform;
    // npm installs agent CLIs as `.cmd` shims on Windows, which Node refuses
    // to spawn without a shell. Arguments are plain flags and absolute paths,
    // so shell interpolation has nothing to mangle.
    const child = spawn(bin, args, {
      cwd: options.cwd,
      shell: platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      hardKill.unref();
    }, options.timeoutMs);
    deadline.unref();

    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve({ code: code ?? 1, stderr, stdout, timedOut });
    });
    // `close` waits for the stdio pipes, which a killed agent's own children
    // (an MCP server, a shell) can hold open past the SIGTERM. A timed-out
    // run's output is discarded anyway, so the process dying is enough.
    child.once("exit", (code) => {
      if (timedOut) {
        clearTimeout(deadline);
        resolve({ code: code ?? 1, stderr, stdout, timedOut });
      }
    });

    child.stdin.end(options.prompt);
  });

/** The spawn signature `runEval` accepts, injectable for tests. */
export type HeadlessRunner = typeof runAgentHeadless;

/** How the eval reaches the MCP stdio bridge from a spawned agent. */
export interface McpLaunch {
  /** The generated MCP config file (claude's `--mcp-config`). */
  configPath: string;
  /** argv for the bridge process (codex's `-c mcp_servers` override). */
  serverArgs: string[];
  /** The executable launching the bridge. */
  serverCommand: string;
}

/**
 * Write the MCP config a reader run points its agent CLI at. The bridge is
 * this same CLI relaunched (`blume mcp-stdio`), which resolves correctly from
 * both a source checkout (bun + src/cli/index.ts) and an installed package
 * (node + bin/blume.mjs).
 */
export const writeMcpConfig = async (
  dir: string,
  snapshotPath: string,
  launcher?: { args: string[]; command: string }
): Promise<McpLaunch> => {
  const resolved = launcher ?? {
    args: [process.argv[1] ?? "", "mcp-stdio", "--data", snapshotPath],
    command: process.execPath,
  };
  const configPath = join(dir, "mcp-config.json");
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: { args: resolved.args, command: resolved.command },
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return {
    configPath,
    serverArgs: resolved.args,
    serverCommand: resolved.command,
  };
};

export interface InvocationContext {
  /** Where codex writes its final message; unused by claude. */
  lastMessagePath: string;
  /** The MCP bridge for reader runs; omitted for the judge. */
  mcp?: McpLaunch;
}

const CLAUDE_READER_MAX_TURNS = "25";
const CLAUDE_JUDGE_MAX_TURNS = "1";

const claudeArgs = (context: InvocationContext): string[] => {
  const base = ["-p", "--output-format", "json", "--strict-mcp-config"];
  if (context.mcp) {
    const allowed = MCP_TOOL_NAMES.map(
      (tool) => `mcp__${MCP_SERVER_NAME}__${tool}`
    ).join(",");
    return [
      ...base,
      "--mcp-config",
      context.mcp.configPath,
      "--allowedTools",
      allowed,
      "--disallowedTools",
      DISALLOWED_TOOLS.join(","),
      "--max-turns",
      CLAUDE_READER_MAX_TURNS,
    ];
  }
  return [
    ...base,
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
    "--max-turns",
    CLAUDE_JUDGE_MAX_TURNS,
  ];
};

const codexArgs = (context: InvocationContext): string[] => {
  const base = [
    "exec",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--output-last-message",
    context.lastMessagePath,
  ];
  if (context.mcp) {
    // `-c` values parse as TOML; JSON string/array literals are valid TOML
    // values, so JSON.stringify produces exactly the quoting codex expects.
    return [
      ...base,
      "-c",
      `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(
        context.mcp.serverCommand
      )}`,
      "-c",
      `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(
        context.mcp.serverArgs
      )}`,
      "-",
    ];
  }
  return [...base, "-"];
};

/** Build the argv for one headless run; pass `mcp` for the reader role. */
export const agentArgs = (
  kind: AgentKind,
  context: InvocationContext
): string[] => (kind === "claude" ? claudeArgs(context) : codexArgs(context));

/** What one headless run produced, normalized across agent CLIs. */
export interface AgentOutput {
  costUsd?: number;
  detail?: string;
  isError: boolean;
  text: string;
}

const claudeResultSchema = z.object({
  is_error: z.boolean().default(false),
  result: z.string().default(""),
  total_cost_usd: z.number().optional(),
});

const tail = (value: string, max = 300): string => {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
};

/**
 * Normalize a finished run into the answer text. Claude prints one JSON
 * object on stdout (`--output-format json`); codex writes the final message
 * to `--output-last-message` because its stdout interleaves progress.
 */
export const readAgentOutput = async (
  kind: AgentKind,
  result: HeadlessResult,
  lastMessagePath: string
): Promise<AgentOutput> => {
  if (result.timedOut) {
    return { detail: "timed out", isError: true, text: "" };
  }
  if (result.code !== 0) {
    return {
      detail: tail(result.stderr) || `exited with code ${result.code}`,
      isError: true,
      text: "",
    };
  }

  if (kind === "claude") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return {
        detail: "unparseable --output-format json payload",
        isError: true,
        text: "",
      };
    }
    const payload = claudeResultSchema.safeParse(parsed);
    if (!payload.success) {
      return {
        detail: "unexpected --output-format json shape",
        isError: true,
        text: "",
      };
    }
    return {
      costUsd: payload.data.total_cost_usd,
      isError: payload.data.is_error,
      text: payload.data.result,
    };
  }

  let text: string;
  try {
    const raw = await readFile(lastMessagePath, "utf-8");
    text = raw.trim();
  } catch {
    return { detail: "no last message written", isError: true, text: "" };
  }
  if (text === "") {
    return { detail: "empty last message", isError: true, text: "" };
  }
  return { isError: false, text };
};

const verdictSchema = z.object({
  missing: z.array(z.string()).default([]),
  notes: z.string().default(""),
  pass: z.boolean(),
  score: z.number().min(0).max(1).optional(),
});

/** The judge's grade for one answer. */
export type Verdict = z.infer<typeof verdictSchema>;

/**
 * Extract the verdict JSON from a judge reply. Tolerates markdown fences and
 * surrounding prose; returns undefined when no valid verdict can be found.
 */
export const parseVerdict = (text: string): Verdict | undefined => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return;
  }
  const result = verdictSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};
