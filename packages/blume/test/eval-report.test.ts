import { afterAll, describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";

import { dirname } from "pathe";

import {
  evalReportJson,
  fixLines,
  formatEvalReport,
  headerLine,
  questionLine,
  startLine,
  summaryLine,
  warningLines,
  writeEvalReport,
} from "../src/eval/report.ts";
import type { EvalResult, QuestionResult } from "../src/eval/run.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

// oxlint-disable-next-line no-control-regex -- ANSI stripping for assertions
const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "gu");
const strip = (value: string): string => value.replaceAll(ANSI, "");

const passResult: QuestionResult = {
  answer: "Node 22.12 or newer.",
  costUsd: 0.12,
  durationMs: 14_200,
  expected: ["Node 22.12 or newer"],
  id: "install-node-version",
  missing: [],
  question: "What is the minimum Node.js version?",
  routes: ["/guides/install"],
  score: 1,
  status: "pass",
};

const failResult: QuestionResult = {
  answer: "The docs do not say.",
  costUsd: 0.31,
  durationMs: 38_900,
  expected: ["run blume build", "the adapter is auto-detected"],
  id: "deploy-vercel",
  missing: ["the adapter is auto-detected"],
  notes: "close but incomplete",
  question: "How do I deploy to Vercel?",
  routes: ["/guides/deploy"],
  score: 0.4,
  status: "fail",
};

const result: EvalResult = {
  agent: "claude",
  costUsd: 0.71,
  counts: { error: 1, fail: 1, pass: 1, skip: 1 },
  diagnostics: [
    {
      code: "BLUME_EVAL_QUESTION_FAILED",
      file: "/root/docs/deploy.mdx",
      message: 'Docs could not answer: "How do I deploy to Vercel?"',
      severity: "error",
      suggestion: "State the missing facts on this page.",
      url: "/guides/deploy",
    },
    {
      code: "BLUME_EVAL_ROUTE_UNKNOWN",
      file: "/root/evals.yaml",
      line: 12,
      message: 'Question "gone" hints at route "/gone", which matches no page.',
      severity: "warning",
    },
  ],
  durationMs: 102_000,
  results: [
    passResult,
    failResult,
    {
      detail: "reader timed out",
      durationMs: 180_000,
      expected: ["anything"],
      id: "stuck",
      missing: [],
      question: "Does it hang?",
      routes: [],
      status: "error",
    },
    {
      durationMs: 0,
      expected: ["later"],
      id: "old-flags",
      missing: [],
      question: "Skipped?",
      routes: [],
      status: "skip",
    },
  ],
};

describe("questionLine and summaryLine", () => {
  it("renders status, score, duration, and cost per question", () => {
    const pass = strip(questionLine(passResult));
    expect(pass).toContain("✔");
    expect(pass).toContain("install-node-version");
    expect(pass).toContain("pass");
    expect(pass).toContain("1.00");
    expect(pass).toContain("14.2s");
    expect(pass).toContain("$0.12");

    const skip = strip(
      questionLine({
        durationMs: 0,
        expected: [],
        id: "later",
        missing: [],
        question: "",
        routes: [],
        status: "skip",
      })
    );
    expect(skip).toContain("⊘");
    expect(skip).toContain("skipped");
  });

  it("summarizes counts, wall time, and spend, omitting zero counts", () => {
    expect(summaryLine(result)).toBe(
      "1 passed · 1 failed · 1 errored · 1 skipped · 1m 42s · $0.71"
    );
    expect(
      summaryLine({
        ...result,
        costUsd: undefined,
        counts: { error: 0, fail: 0, pass: 3, skip: 0 },
        durationMs: 59_000,
      })
    ).toBe("3 passed · 59.0s");
  });
});

describe("progress lines", () => {
  it("announces the run and each question as it starts", () => {
    expect(strip(headerLine(4, "claude"))).toBe(
      "blume eval  4 question(s) · Claude Code"
    );
    expect(strip(startLine("deploy-vercel", 1, 4))).toBe(
      "  ▸ deploy-vercel (2/4)"
    );
  });

  it("renders stale route hints as warnings with their evals-file line", () => {
    const warnings = warningLines(result, "/root").map(strip);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("⚠ evals.yaml:12");
    expect(warnings[0]).toContain("matches no page");
  });
});

describe("fixLines", () => {
  it("points a failed question at its page and an errored run at its question", () => {
    const lines = fixLines(
      {
        ...result,
        diagnostics: [
          ...result.diagnostics,
          {
            code: "BLUME_EVAL_QUESTION_ERROR",
            file: "/root/evals.yaml",
            line: 20,
            message:
              'The agent run failed for "Where are the logs?" — reader timed out, so the docs weren\'t graded.',
            severity: "error",
          },
        ],
      },
      "/root"
    ).map(strip);
    expect(lines).toEqual([
      '  fix: docs/deploy.mdx Docs could not answer: "How do I deploy to Vercel?"',
      '  run failed: evals.yaml:20 The agent run failed for "Where are the logs?" — reader timed out, so the docs weren\'t graded.',
    ]);
  });
});

describe("a warning-severity miss", () => {
  const warned: QuestionResult = { ...failResult, severity: "warning" };
  const finding = {
    code: "BLUME_EVAL_QUESTION_FAILED",
    file: "/root/docs/deploy.mdx",
    message: 'Docs could not answer: "How do I deploy to Vercel?"',
    severity: "warning" as const,
  };
  const withWarning: EvalResult = {
    ...result,
    counts: { error: 0, fail: 1, pass: 1, skip: 0 },
    diagnostics: [finding],
    results: [passResult, warned],
  };

  it("reads as a warning on its question line", () => {
    const line = strip(questionLine(warned));
    expect(line).toContain("⚠ deploy-vercel");
    expect(line).toContain("warn  0.40");
    expect(line).not.toContain("fail");
    expect(strip(questionLine(failResult))).toContain("✖ deploy-vercel");
  });

  it("counts as warned, not failed, in the summary", () => {
    expect(summaryLine(withWarning)).toBe(
      "1 passed · 1 warned · 1m 42s · $0.71"
    );
  });

  it("prints as a warning line instead of a fix line", () => {
    expect(fixLines(withWarning, "/root")).toEqual([]);
    expect(warningLines(withWarning, "/root").map(strip)).toEqual([
      '  ⚠ docs/deploy.mdx Docs could not answer: "How do I deploy to Vercel?"',
    ]);
    const report = strip(formatEvalReport(withWarning, "/root"));
    expect(report).toContain("⚠ docs/deploy.mdx");
    expect(report).not.toContain("fix:");
  });
});

describe("formatEvalReport", () => {
  it("lists every question, missing facts, and the fix lines", () => {
    const report = strip(formatEvalReport(result, "/root"));
    expect(report).toContain("blume eval  4 question(s) · Claude Code");
    expect(report).toContain("install-node-version");
    expect(report).toContain("missing: the adapter is auto-detected");
    expect(report).toContain("reader timed out");
    expect(report).toContain("fix: docs/deploy.mdx");
    // Route warnings are load-time issues, not failures to fix.
    expect(report).not.toContain("fix: evals.yaml");
    expect(report).toContain("1 passed · 1 failed · 1 errored · 1 skipped");
  });

  it("includes the reader's answer under failures only with --verbose", () => {
    const terse = strip(formatEvalReport(result, "/root"));
    expect(terse).not.toContain("> The docs do not say.");
    const verbose = strip(formatEvalReport(result, "/root", { verbose: true }));
    expect(verbose).toContain("> The docs do not say.");
  });
});

describe("evalReportJson", () => {
  it("keeps the diagnostics + summary contract with the eval block alongside", () => {
    const parsed = JSON.parse(evalReportJson(result, "/root", 1));
    expect(parsed.summary).toEqual({ error: 1, info: 0, warning: 1 });
    expect(parsed.diagnostics[0].file).toBe("docs/deploy.mdx");
    expect(parsed.diagnostics[1].file).toBe("evals.yaml");
    expect(parsed.eval.agent).toBe("claude");
    expect(parsed.eval.threshold).toBe(1);
    expect(parsed.eval.counts.fail).toBe(1);
    expect(parsed.eval.results).toHaveLength(4);
    expect(parsed.eval.results[1].missing).toEqual([
      "the adapter is auto-detected",
    ]);
  });

  it("passes a file-less diagnostic through without relativizing", () => {
    const parsed = JSON.parse(
      evalReportJson(
        {
          ...result,
          diagnostics: [
            {
              code: "BLUME_EVAL_QUESTION_FAILED",
              message: "Docs could not answer.",
              severity: "error",
            },
          ],
        },
        "/root",
        1
      )
    );
    expect(parsed.diagnostics[0].file).toBeUndefined();
    expect(parsed.summary).toEqual({ error: 1, info: 0, warning: 0 });
  });
});

describe("writeEvalReport", () => {
  it("writes the JSON report into a scratch directory", async () => {
    const path = await writeEvalReport(result, "/root", 0.9);
    dirs.push(dirname(path));
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    expect(parsed.eval.threshold).toBe(0.9);
    expect(path).toContain("blume-eval-");
    expect(path.endsWith("report.json")).toBe(true);
  });
});
