import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { scanProject } from "../src/core/project-graph.ts";
import type { Diagnostic } from "../src/core/types.ts";
import type { HeadlessRunner } from "../src/eval/agents.ts";
import { evalReportJson, summaryLine } from "../src/eval/report.ts";
import { passFraction, runEval } from "../src/eval/run.ts";
import type { EvalResult, QuestionResult } from "../src/eval/run.ts";
import type { EvalQuestion } from "../src/eval/schema.ts";

/**
 * The CI gate: a `severity: warning` question warns instead of failing, so
 * only error-severity misses count against `--threshold` — and the exit code
 * agrees with the JSON summary's error count.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const question = (id: string, status: QuestionResult["status"]) => ({
  durationMs: 1,
  expected: [],
  id,
  missing: [],
  question: id,
  routes: [],
  status,
});

const miss = (
  code: "BLUME_EVAL_QUESTION_ERROR" | "BLUME_EVAL_QUESTION_FAILED",
  severity: Diagnostic["severity"]
): Diagnostic => ({ code, message: "missed", severity });

const result = (
  statuses: QuestionResult["status"][],
  diagnostics: Diagnostic[]
): EvalResult => {
  const counts = { error: 0, fail: 0, pass: 0, skip: 0 };
  for (const status of statuses) {
    counts[status] += 1;
  }
  return {
    agent: "codex",
    counts,
    diagnostics,
    durationMs: 1,
    results: statuses.map((status, index) => question(`q${index}`, status)),
  };
};

describe("passFraction", () => {
  it("doesn't count a warning-severity miss against the gate", () => {
    expect(
      passFraction(
        result(
          ["pass", "fail", "error"],
          [
            miss("BLUME_EVAL_QUESTION_FAILED", "warning"),
            miss("BLUME_EVAL_QUESTION_ERROR", "warning"),
          ]
        )
      )
    ).toBe(1);
  });

  it("counts error-severity misses, failed or errored", () => {
    expect(
      passFraction(
        result(
          ["pass", "fail", "error", "pass"],
          [
            miss("BLUME_EVAL_QUESTION_FAILED", "error"),
            miss("BLUME_EVAL_QUESTION_ERROR", "error"),
          ]
        )
      )
    ).toBe(0.5);
  });

  it("ignores route-hint warnings and skipped questions", () => {
    expect(
      passFraction(
        result(
          ["pass", "skip"],
          [
            {
              code: "BLUME_EVAL_ROUTE_UNKNOWN",
              message: "gone",
              severity: "warning",
            },
          ]
        )
      )
    ).toBe(1);
    expect(passFraction(result(["skip"], []))).toBe(1);
  });
});

/** A claude-shaped runner whose judge passes the home-page question only. */
const judgeHomePageOnly: HeadlessRunner = (_bin, args, options) => {
  const reader = args.includes("--mcp-config");
  const pass = options.prompt.includes("home page");
  const text = reader
    ? "An answer."
    : JSON.stringify({ missing: pass ? [] : ["Orama"], pass });
  return Promise.resolve({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({ is_error: false, result: text }),
    timedOut: false,
  });
};

describe("a run with a failing warning-severity question", () => {
  it("passes the gate, matching the JSON summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-eval-gate-"));
    dirs.push(root);
    const files = {
      "blume.config.ts": 'export default { title: "Test Docs" };',
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n\nWelcome.\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        const abs = join(root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      })
    );
    const questions: EvalQuestion[] = [
      {
        expected: ["Welcome"],
        id: "greeting",
        question: "What does the home page say?",
        routes: [],
        severity: "error",
        skip: false,
      },
      {
        expected: ["Orama"],
        id: "search",
        question: "Which search provider is the default?",
        routes: [],
        severity: "warning",
        skip: false,
      },
    ];
    const evaluated = await runEval({
      agent: "claude",
      evals: { questions, version: 1 },
      evalsPath: join(root, "evals.yaml"),
      project: await scanProject(root),
      rawEvals: "",
      run: judgeHomePageOnly,
    });

    expect(evaluated.counts).toEqual({ error: 0, fail: 1, pass: 1, skip: 0 });
    expect(evaluated.results[1]?.severity).toBe("warning");
    expect(summaryLine(evaluated)).toStartWith("1 passed · 1 warned · ");
    expect(passFraction(evaluated)).toBe(1);
    expect(
      JSON.parse(evalReportJson(evaluated, root, 1)).summary
    ).toMatchObject({ error: 0, warning: 1 });
  });
});
