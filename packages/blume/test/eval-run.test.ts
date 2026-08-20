import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import type { HeadlessResult, HeadlessRunner } from "../src/eval/agents.ts";
import { runEval } from "../src/eval/run.ts";
import type { EvalProgress } from "../src/eval/run.ts";
import type { EvalsFile } from "../src/eval/schema.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const projectFixture = async (): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-eval-run-"));
  dirs.push(root);
  const files = {
    "blume.config.ts": 'export default { title: "Test Docs" };',
    "docs/guides/install.md":
      "---\ntitle: Installation\ndescription: How to install\n---\n# Installation\n\nNode 22.12 or newer.\n",
    "docs/index.md": "---\ntitle: Home\n---\n# Home\n\nWelcome.\n",
  } satisfies Record<string, string>;
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return await scanProject(root);
};

const question = (
  partial: Partial<EvalsFile["questions"][number]> & { id: string }
): EvalsFile["questions"][number] => ({
  expected: ["Node 22.12 or newer"],
  question: "What is the minimum Node.js version?",
  routes: [],
  severity: "error",
  skip: false,
  ...partial,
});

const rawFor = (evals: EvalsFile): string =>
  evals.questions.map((entry) => `- id: ${entry.id}\n  question: q\n`).join("");

const ok = (stdout: string): HeadlessResult => ({
  code: 0,
  stderr: "",
  stdout,
  timedOut: false,
});

const claudePayload = (result: string, cost = 0.1): string =>
  JSON.stringify({ is_error: false, result, total_cost_usd: cost });

/**
 * A claude-shaped fake runner: replies with the canned answer for reader
 * invocations (spotted by `--mcp-config`) and the canned verdict otherwise.
 */
const claudeRunner =
  (answers: {
    answer?: string;
    verdict?: string;
    onCall?: (args: string[], prompt: string) => void;
  }): HeadlessRunner =>
  (bin, args, options) => {
    answers.onCall?.(args, options.prompt);
    if (args.includes("--mcp-config")) {
      return Promise.resolve(
        ok(claudePayload(answers.answer ?? "The docs say Node 22.12 or newer."))
      );
    }
    return Promise.resolve(
      ok(
        claudePayload(
          answers.verdict ?? '{"pass": true, "score": 1, "missing": []}'
        )
      )
    );
  };

describe("runEval", () => {
  it("runs reader and judge per question and sums cost", async () => {
    const project = await projectFixture();
    const evals: EvalsFile = {
      questions: [
        question({ id: "one", routes: ["/guides/install"] }),
        question({ id: "two" }),
      ],
      version: 1,
    };
    const events: EvalProgress[] = [];
    const prompts: string[] = [];
    const result = await runEval({
      agent: "claude",
      evals,
      evalsPath: "/project/evals.yaml",
      onProgress: (event) => events.push(event),
      project,
      rawEvals: rawFor(evals),
      run: claudeRunner({ onCall: (_args, prompt) => prompts.push(prompt) }),
    });

    expect(result.counts).toEqual({ error: 0, fail: 0, pass: 2, skip: 0 });
    expect(result.diagnostics).toHaveLength(0);
    // Reader + judge per question, each carrying claude's canned $0.10.
    expect(result.costUsd).toBeCloseTo(0.4);
    expect(result.results.map((entry) => entry.status)).toEqual([
      "pass",
      "pass",
    ]);

    // The reader sees the question; the judge sees the answer.
    expect(prompts[0]).toContain("What is the minimum Node.js version?");
    expect(prompts[1]).toContain("The docs say Node 22.12 or newer.");

    expect(events.map((event) => event.kind)).toEqual([
      "question-start",
      "question-end",
      "question-start",
      "question-end",
    ]);
  });

  it("anchors a failed question to the hinted route's source page", async () => {
    const project = await projectFixture();
    const evals: EvalsFile = {
      questions: [question({ id: "install", routes: ["/guides/install"] })],
      version: 1,
    };
    const result = await runEval({
      agent: "claude",
      evals,
      evalsPath: "/project/evals.yaml",
      project,
      rawEvals: rawFor(evals),
      run: claudeRunner({
        verdict:
          '{"pass": false, "score": 0.2, "missing": ["Node 22.12 or newer"], "notes": "vague"}',
      }),
    });

    expect(result.counts.fail).toBe(1);
    const [finding] = result.diagnostics;
    expect(finding?.code).toBe("BLUME_EVAL_QUESTION_FAILED");
    expect(finding?.url).toBe("/guides/install");
    expect(finding?.file).toContain("guides/install.md");
    expect(finding?.message).toContain("missing: Node 22.12 or newer");
    expect(result.results[0]?.score).toBe(0.2);
    expect(result.results[0]?.notes).toBe("vague");
  });

  it("falls back to the evals file anchor and warns on unknown route hints", async () => {
    const project = await projectFixture();
    const evals: EvalsFile = {
      questions: [question({ id: "misrouted", routes: ["/guides/gone"] })],
      version: 1,
    };
    const raw = rawFor(evals);
    const result = await runEval({
      agent: "claude",
      evals,
      evalsPath: "/project/evals.yaml",
      project,
      rawEvals: raw,
      run: claudeRunner({ verdict: '{"pass": false, "missing": ["x"]}' }),
    });

    const codes = result.diagnostics.map((entry) => entry.code);
    expect(codes).toContain("BLUME_EVAL_ROUTE_UNKNOWN");
    const failed = result.diagnostics.find(
      (entry) => entry.code === "BLUME_EVAL_QUESTION_FAILED"
    );
    expect(failed?.file).toBe("/project/evals.yaml");
    expect(failed?.line).toBe(1);
    expect(failed?.url).toBeUndefined();
  });

  it("marks reader failures, judge failures, and unparseable verdicts as errors", async () => {
    const project = await projectFixture();
    const evals: EvalsFile = {
      questions: [
        question({ id: "reader-dies" }),
        question({ id: "judge-dies" }),
        question({ id: "garbled" }),
      ],
      version: 1,
    };

    let index = 0;
    const scripted: HeadlessRunner = (bin, args) => {
      const reader = args.includes("--mcp-config");
      index += 1;
      // Question 1: the reader times out (no judge call happens). Questions
      // 2–3: readers succeed; one judge crashes, one replies with prose.
      if (reader && index === 1) {
        return Promise.resolve({ ...ok(""), timedOut: true });
      }
      if (reader) {
        return Promise.resolve(ok(claudePayload("an answer")));
      }
      if (index === 3) {
        return Promise.resolve({
          code: 1,
          stderr: "judge crashed",
          stdout: "",
          timedOut: false,
        });
      }
      return Promise.resolve(ok(claudePayload("no json here")));
    };

    const result = await runEval({
      agent: "claude",
      evals,
      evalsPath: "/project/evals.yaml",
      project,
      rawEvals: rawFor(evals),
      run: scripted,
    });

    expect(result.counts.error).toBe(3);
    const details = result.results.map((entry) => entry.detail);
    expect(details[0]).toBe("reader timed out");
    expect(details[1]).toBe("judge judge crashed");
    expect(details[2]).toBe("judge returned no parseable verdict");
    for (const finding of result.diagnostics) {
      expect(finding.code).toBe("BLUME_EVAL_QUESTION_ERROR");
    }
  });

  it("skips flagged questions without spawning any agent", async () => {
    const project = await projectFixture();
    const evals: EvalsFile = {
      questions: [question({ id: "later", skip: true })],
      version: 1,
    };
    const calls: string[][] = [];
    const result = await runEval({
      agent: "claude",
      evals,
      evalsPath: "/project/evals.yaml",
      project,
      rawEvals: rawFor(evals),
      run: (bin, args) => {
        calls.push(args);
        return Promise.resolve(ok(claudePayload("")));
      },
    });
    expect(calls).toHaveLength(0);
    expect(result.counts.skip).toBe(1);
    expect(result.results[0]?.status).toBe("skip");
    expect(result.costUsd).toBeUndefined();
  });

  it("drives codex through last-message files and reports no cost", async () => {
    const project = await projectFixture();
    const evals: EvalsFile = {
      questions: [question({ id: "codex-run" })],
      version: 1,
    };
    const codexRunner: HeadlessRunner = async (bin, args) => {
      const at = args.indexOf("--output-last-message");
      const path = args[at + 1] ?? "";
      const reader = args.some((arg) => arg.startsWith("mcp_servers."));
      await writeFile(
        path,
        reader ? "The docs say Node 22.12.\n" : '{"pass": true}\n'
      );
      return ok("progress noise\n");
    };
    const result = await runEval({
      agent: "codex",
      evals,
      evalsPath: "/project/evals.yaml",
      project,
      rawEvals: rawFor(evals),
      run: codexRunner,
    });
    expect(result.counts.pass).toBe(1);
    expect(result.results[0]?.answer).toBe("The docs say Node 22.12.");
    expect(result.costUsd).toBeUndefined();
  });

  it("hands the reader an MCP config pointing at the generated snapshot", async () => {
    const project = await projectFixture();
    const evals: EvalsFile = {
      questions: [question({ id: "wired" })],
      version: 1,
    };
    let mcpConfigPath = "";
    await runEval({
      agent: "claude",
      evals,
      evalsPath: "/project/evals.yaml",
      project,
      rawEvals: rawFor(evals),
      run: claudeRunner({
        onCall: (args) => {
          const at = args.indexOf("--mcp-config");
          if (at !== -1) {
            mcpConfigPath = args[at + 1] ?? "";
          }
        },
      }),
    });
    const config = JSON.parse(await readFile(mcpConfigPath, "utf-8"));
    const server = config.mcpServers.docs;
    expect(server.args).toContain("mcp-stdio");
    const snapshotPath = server.args.at(-1);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(snapshot.name).toBe("Test Docs");
    expect(Object.keys(snapshot.pages)).toContain("/guides/install");
  });
});
