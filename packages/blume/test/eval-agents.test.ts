import { afterAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  agentArgs,
  parseVerdict,
  readAgentOutput,
  runAgentHeadless,
  writeMcpConfig,
} from "../src/eval/agents.ts";
import type { HeadlessResult } from "../src/eval/agents.ts";
import {
  evalFixPrompt,
  initPrompt,
  judgePrompt,
  readerPrompt,
} from "../src/eval/prompts.ts";
import type { EvalQuestion } from "../src/eval/schema.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-eval-agents-"));
  dirs.push(dir);
  return dir;
};

/** A fake agent executable whose behavior is the given shell script body. */
const fakeBin = async (dir: string, body: string): Promise<string> => {
  const path = join(dir, "fake-agent");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

const QUESTION: EvalQuestion = {
  expected: ["Node 22.12 or newer"],
  id: "install-node-version",
  question: "What is the minimum Node.js version required?",
  routes: ["/guides/install"],
  severity: "error",
  skip: false,
};

describe("runAgentHeadless", () => {
  it("delivers the prompt on stdin and captures stdout, stderr, and the exit code", async () => {
    const dir = await scratch();
    const bin = await fakeBin(dir, `cat\nprintf 'warned\\n' >&2\nexit 3`);
    const result = await runAgentHeadless(bin, [], {
      cwd: dir,
      prompt: "the prompt text",
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("the prompt text");
    expect(result.stderr).toBe("warned\n");
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("kills a run at the deadline and reports the timeout", async () => {
    const dir = await scratch();
    const bin = await fakeBin(dir, "sleep 30");
    const result = await runAgentHeadless(bin, [], {
      cwd: dir,
      prompt: "",
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  });

  it("rejects when the executable does not exist", async () => {
    const dir = await scratch();
    await expect(
      runAgentHeadless(join(dir, "not-installed"), [], {
        cwd: dir,
        prompt: "",
        timeoutMs: 1000,
      })
    ).rejects.toThrow();
  });
});

describe("writeMcpConfig", () => {
  it("writes a config whose server relaunches this CLI as the stdio bridge", async () => {
    const dir = await scratch();
    const launch = await writeMcpConfig(dir, "/tmp/mcp-data.json", {
      args: [
        "/repo/src/cli/index.ts",
        "mcp-stdio",
        "--data",
        "/tmp/mcp-data.json",
      ],
      command: "/usr/local/bin/bun",
    });
    const written = JSON.parse(await readFile(launch.configPath, "utf-8"));
    expect(written.mcpServers.docs.command).toBe("/usr/local/bin/bun");
    expect(written.mcpServers.docs.args).toEqual([
      "/repo/src/cli/index.ts",
      "mcp-stdio",
      "--data",
      "/tmp/mcp-data.json",
    ]);
    expect(launch.serverCommand).toBe("/usr/local/bin/bun");
  });

  it("defaults the launcher to the running process", async () => {
    const dir = await scratch();
    const launch = await writeMcpConfig(dir, "/tmp/snapshot.json");
    expect(launch.serverCommand).toBe(process.execPath);
    expect(launch.serverArgs).toContain("mcp-stdio");
    expect(launch.serverArgs).toContain("/tmp/snapshot.json");
  });
});

describe("agentArgs", () => {
  const mcp = {
    configPath: "/work/mcp-config.json",
    serverArgs: ["/cli.ts", "mcp-stdio", "--data", "/snap.json"],
    serverCommand: "/bin/bun",
  };

  it("builds the claude reader argv: MCP config, tool allowlist, headless JSON", () => {
    const args = agentArgs("claude", {
      lastMessagePath: "/work/answer.txt",
      mcp,
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--mcp-config",
      "/work/mcp-config.json",
      "--allowedTools",
      "mcp__docs__search_docs,mcp__docs__get_page,mcp__docs__list_pages,mcp__docs__get_navigation",
      "--disallowedTools",
      "Bash,Read,Glob,Grep,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task",
      "--max-turns",
      "25",
    ]);
  });

  it("builds the claude judge argv: no MCP servers, one turn", () => {
    const args = agentArgs("claude", { lastMessagePath: "/work/verdict.txt" });
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).toEqual(expect.arrayContaining(["--max-turns", "1"]));
  });

  it("builds the codex reader argv: TOML server overrides, stdin prompt", () => {
    const args = agentArgs("codex", {
      lastMessagePath: "/work/answer.txt",
      mcp,
    });
    expect(args[0]).toBe("exec");
    expect(args).toEqual(
      expect.arrayContaining([
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ephemeral",
        "--output-last-message",
        "/work/answer.txt",
        'mcp_servers.docs.command="/bin/bun"',
        'mcp_servers.docs.args=["/cli.ts","mcp-stdio","--data","/snap.json"]',
      ])
    );
    expect(args.at(-1)).toBe("-");
  });

  it("builds the codex judge argv without MCP overrides", () => {
    const args = agentArgs("codex", { lastMessagePath: "/work/verdict.txt" });
    expect(args.join(" ")).not.toContain("mcp_servers");
    expect(args.at(-1)).toBe("-");
  });
});

const finished = (partial: Partial<HeadlessResult>): HeadlessResult => ({
  code: 0,
  stderr: "",
  stdout: "",
  timedOut: false,
  ...partial,
});

describe("readAgentOutput", () => {
  it("reads a claude JSON payload with answer and cost", async () => {
    const output = await readAgentOutput(
      "claude",
      finished({
        stdout: JSON.stringify({
          is_error: false,
          result: "Node 22.12 or newer.",
          total_cost_usd: 0.12,
        }),
      }),
      "/nowhere"
    );
    expect(output.isError).toBe(false);
    expect(output.text).toBe("Node 22.12 or newer.");
    expect(output.costUsd).toBe(0.12);
  });

  it("surfaces claude's is_error flag and rejects malformed payloads", async () => {
    const flagged = await readAgentOutput(
      "claude",
      finished({ stdout: JSON.stringify({ is_error: true, result: "nope" }) }),
      "/nowhere"
    );
    expect(flagged.isError).toBe(true);

    const garbage = await readAgentOutput(
      "claude",
      finished({ stdout: "not json" }),
      "/nowhere"
    );
    expect(garbage.isError).toBe(true);
    expect(garbage.detail).toContain("unparseable");

    const mistyped = await readAgentOutput(
      "claude",
      finished({ stdout: JSON.stringify({ result: 42 }) }),
      "/nowhere"
    );
    expect(mistyped.isError).toBe(true);
    expect(mistyped.detail).toContain("shape");
  });

  it("reads the codex last-message file and flags a missing or empty one", async () => {
    const dir = await scratch();
    const path = join(dir, "answer.txt");
    await writeFile(path, "The docs say Node 22.12.\n");
    const output = await readAgentOutput("codex", finished({}), path);
    expect(output.isError).toBe(false);
    expect(output.text).toBe("The docs say Node 22.12.");
    expect(output.costUsd).toBeUndefined();

    const missing = await readAgentOutput(
      "codex",
      finished({}),
      join(dir, "never-written.txt")
    );
    expect(missing.isError).toBe(true);
    expect(missing.detail).toContain("no last message");

    await writeFile(path, "   \n");
    const empty = await readAgentOutput("codex", finished({}), path);
    expect(empty.isError).toBe(true);
    expect(empty.detail).toContain("empty");
  });

  it("maps timeouts and nonzero exits to errors before any parsing", async () => {
    const timedOut = await readAgentOutput(
      "claude",
      finished({ timedOut: true }),
      "/nowhere"
    );
    expect(timedOut.isError).toBe(true);
    expect(timedOut.detail).toBe("timed out");

    const crashed = await readAgentOutput(
      "codex",
      finished({ code: 2, stderr: "boom\n" }),
      "/nowhere"
    );
    expect(crashed.isError).toBe(true);
    expect(crashed.detail).toBe("boom");

    const silent = await readAgentOutput(
      "claude",
      finished({ code: 1 }),
      "/nowhere"
    );
    expect(silent.detail).toBe("exited with code 1");
  });
});

describe("parseVerdict", () => {
  it("parses a bare verdict and applies defaults", () => {
    const verdict = parseVerdict('{"pass": true}');
    expect(verdict?.pass).toBe(true);
    expect(verdict?.missing).toEqual([]);
    expect(verdict?.notes).toBe("");
    expect(verdict?.score).toBeUndefined();
  });

  it("tolerates fences and surrounding prose", () => {
    const verdict = parseVerdict(
      'Here you go:\n```json\n{"pass": false, "score": 0.4, "missing": ["the adapter"], "notes": "close"}\n```\nDone.'
    );
    expect(verdict?.pass).toBe(false);
    expect(verdict?.score).toBe(0.4);
    expect(verdict?.missing).toEqual(["the adapter"]);
  });

  it("returns undefined for garbage, no JSON, or the wrong shape", () => {
    expect(parseVerdict("I could not grade this.")).toBeUndefined();
    expect(parseVerdict("{not json}")).toBeUndefined();
    expect(parseVerdict('{"score": 2}')).toBeUndefined();
  });
});

describe("prompts", () => {
  it("readerPrompt names the MCP tools and forbids prior knowledge", () => {
    const prompt = readerPrompt(QUESTION);
    expect(prompt).toContain("search_docs");
    expect(prompt).toContain(QUESTION.question);
    expect(prompt).toContain("prior knowledge");
  });

  it("judgePrompt lists every expected fact and demands bare JSON", () => {
    const prompt = judgePrompt(QUESTION, "The docs say Node 22.12.");
    expect(prompt).toContain("- Node 22.12 or newer");
    expect(prompt).toContain("The docs say Node 22.12.");
    expect(prompt).toContain('{"pass"');
    expect(prompt).toContain("FAILS");
  });

  it("evalFixPrompt points at the report and protects the evals file", () => {
    const prompt = evalFixPrompt("/tmp/report.json");
    expect(prompt).toContain("/tmp/report.json");
    expect(prompt).toContain("Never delete questions");
    expect(prompt).toContain("blume eval");
  });

  it("initPrompt names the target file and the format", () => {
    const prompt = initPrompt("evals.yaml");
    expect(prompt).toContain("evals.yaml");
    expect(prompt).toContain("questions:");
    expect(prompt).toContain("kebab-case-slug");
  });
});
