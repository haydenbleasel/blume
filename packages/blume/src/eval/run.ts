import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { buildMcpData } from "../ai/mcp/data.ts";
import { AGENTS } from "../audit/agent.ts";
import type { AgentKind } from "../audit/agent.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { Diagnostic } from "../core/types.ts";
import {
  agentArgs,
  parseVerdict,
  readAgentOutput,
  runAgentHeadless,
  writeMcpConfig,
} from "./agents.ts";
import type { HeadlessRunner } from "./agents.ts";
import { questionFinding, routeFindings } from "./findings.ts";
import { judgePrompt, readerPrompt } from "./prompts.ts";
import type { EvalQuestion, EvalsFile } from "./schema.ts";

/** Reader runs search and read several pages; the judge grades one answer. */
const DEFAULT_READER_TIMEOUT_MS = 180_000;
const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

export type QuestionStatus = "error" | "fail" | "pass" | "skip";

/** One question's outcome, carrying everything the reports print. */
export interface QuestionResult {
  answer?: string;
  costUsd?: number;
  /** Why the run errored (timeout, agent failure, unparseable verdict). */
  detail?: string;
  durationMs: number;
  expected: string[];
  id: string;
  missing: string[];
  notes?: string;
  question: string;
  routes: string[];
  score?: number;
  status: QuestionStatus;
}

export interface EvalResult {
  agent: AgentKind;
  /** Total spend, when the agent CLI reports it (claude does, codex doesn't). */
  costUsd?: number;
  counts: Record<QuestionStatus, number>;
  diagnostics: Diagnostic[];
  durationMs: number;
  results: QuestionResult[];
}

export type EvalProgress =
  | {
      kind: "question-end";
      index: number;
      result: QuestionResult;
      total: number;
    }
  | { kind: "question-start"; id: string; index: number; total: number };

export interface EvalRunOptions {
  agent: AgentKind;
  evals: EvalsFile;
  /** Where the evals file lives, for findings with no usable route hint. */
  evalsPath: string;
  judgeTimeoutMs?: number;
  onProgress?: (event: EvalProgress) => void;
  project: BlumeProject;
  /** The evals file's raw text, for line-anchoring findings. */
  rawEvals: string;
  readerTimeoutMs?: number;
  /** The spawn function — injectable so tests never launch a real agent. */
  run?: HeadlessRunner;
}

interface QuestionContext {
  bin: string;
  dir: string;
  judgeTimeoutMs: number;
  kind: AgentKind;
  mcp: Awaited<ReturnType<typeof writeMcpConfig>>;
  readerTimeoutMs: number;
  run: HeadlessRunner;
}

const errored = (
  question: EvalQuestion,
  detail: string,
  durationMs: number
): QuestionResult => ({
  detail,
  durationMs,
  expected: question.expected,
  id: question.id,
  missing: [],
  question: question.question,
  routes: question.routes,
  status: "error",
});

/** Run one question: a fresh empty cwd, the reader, then the judge. */
const runQuestion = async (
  question: EvalQuestion,
  index: number,
  context: QuestionContext
): Promise<QuestionResult> => {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  // An empty working directory per invocation is the fresh-eyes guardrail:
  // even if a tool restriction slips, there is nothing here to read.
  const workDir = join(context.dir, `work-${index}`);
  await mkdir(workDir, { recursive: true });

  const answerPath = join(workDir, "answer.txt");
  const reader = await context.run(
    context.bin,
    agentArgs(context.kind, { lastMessagePath: answerPath, mcp: context.mcp }),
    {
      cwd: workDir,
      prompt: readerPrompt(question),
      timeoutMs: context.readerTimeoutMs,
    }
  );
  const answer = await readAgentOutput(context.kind, reader, answerPath);
  if (answer.isError) {
    return {
      ...errored(question, `reader ${answer.detail ?? "failed"}`, elapsed()),
      costUsd: answer.costUsd,
    };
  }

  const verdictPath = join(workDir, "verdict.txt");
  const judge = await context.run(
    context.bin,
    agentArgs(context.kind, { lastMessagePath: verdictPath }),
    {
      cwd: workDir,
      prompt: judgePrompt(question, answer.text),
      timeoutMs: context.judgeTimeoutMs,
    }
  );
  const graded = await readAgentOutput(context.kind, judge, verdictPath);
  const costUsd =
    answer.costUsd === undefined && graded.costUsd === undefined
      ? undefined
      : (answer.costUsd ?? 0) + (graded.costUsd ?? 0);
  if (graded.isError) {
    return {
      ...errored(question, `judge ${graded.detail ?? "failed"}`, elapsed()),
      answer: answer.text,
      costUsd,
    };
  }

  const verdict = parseVerdict(graded.text);
  if (!verdict) {
    return {
      ...errored(question, "judge returned no parseable verdict", elapsed()),
      answer: answer.text,
      costUsd,
    };
  }

  return {
    answer: answer.text,
    costUsd,
    durationMs: elapsed(),
    expected: question.expected,
    id: question.id,
    missing: verdict.missing,
    notes: verdict.notes || undefined,
    question: question.question,
    routes: question.routes,
    score: verdict.score,
    status: verdict.pass ? "pass" : "fail",
  };
};

/**
 * Run every question through the reader/judge pair, sequentially: each
 * question is already two agent sessions, and a serial run keeps progress
 * output ordered and cost attribution obvious.
 */
export const runEval = async (options: EvalRunOptions): Promise<EvalResult> => {
  const started = performance.now();
  const kind = options.agent;
  const run = options.run ?? runAgentHeadless;
  const anchor = { path: options.evalsPath, raw: options.rawEvals };

  const dir = await mkdtemp(join(tmpdir(), "blume-eval-"));
  const snapshotPath = join(dir, "mcp-data.json");
  await writeFile(
    snapshotPath,
    JSON.stringify(await buildMcpData(options.project))
  );
  const mcp = await writeMcpConfig(dir, snapshotPath);

  const context: QuestionContext = {
    bin: AGENTS[kind].bin,
    dir,
    judgeTimeoutMs: options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
    kind,
    mcp,
    readerTimeoutMs: options.readerTimeoutMs ?? DEFAULT_READER_TIMEOUT_MS,
    run,
  };

  const diagnostics: Diagnostic[] = [];
  const results: QuestionResult[] = [];
  const { questions } = options.evals;

  for (const [index, question] of questions.entries()) {
    diagnostics.push(...routeFindings(question, options.project, anchor));

    if (question.skip) {
      results.push({
        durationMs: 0,
        expected: question.expected,
        id: question.id,
        missing: [],
        question: question.question,
        routes: question.routes,
        status: "skip",
      });
      continue;
    }

    options.onProgress?.({
      id: question.id,
      index,
      kind: "question-start",
      total: questions.length,
    });
    // Sequential by design: each question is already two agent sessions, and
    // a serial run keeps progress output ordered and cost attribution obvious.
    // oxlint-disable-next-line no-await-in-loop
    const result = await runQuestion(question, index, context);
    results.push(result);
    if (result.status === "fail" || result.status === "error") {
      diagnostics.push(
        questionFinding(
          question,
          {
            detail: result.detail,
            missing: result.missing,
            status: result.status,
          },
          options.project,
          anchor
        )
      );
    }
    options.onProgress?.({
      index,
      kind: "question-end",
      result,
      total: questions.length,
    });
  }

  const counts = {
    error: 0,
    fail: 0,
    pass: 0,
    skip: 0,
  } satisfies Record<QuestionStatus, number>;
  for (const result of results) {
    counts[result.status] += 1;
  }
  const costs = results.flatMap((result) =>
    result.costUsd === undefined ? [] : [result.costUsd]
  );

  return {
    agent: kind,
    costUsd:
      costs.length > 0
        ? costs.reduce((total, cost) => total + cost, 0)
        : undefined,
    counts,
    diagnostics,
    durationMs: Math.round(performance.now() - started),
    results,
  };
};
