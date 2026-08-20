import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { colors } from "consola/utils";
import type { ColorFunction } from "consola/utils";
import { join, relative } from "pathe";

import { AGENTS } from "../audit/agent.ts";
import { duration, money, seconds } from "../cli/report-format.ts";
import { countBySeverity } from "../core/diagnostics.ts";
import type { EvalResult, QuestionResult, QuestionStatus } from "./run.ts";

const GLYPH = {
  error: "!",
  fail: "✖",
  pass: "✔",
  skip: "⊘",
} satisfies Record<QuestionStatus, string>;

const STATUS_COLOR = {
  error: colors.yellow,
  fail: colors.red,
  pass: colors.green,
  skip: colors.dim,
} satisfies Record<QuestionStatus, ColorFunction>;

/** Longest id gets the room; everything shorter aligns to it. */
const ID_PAD = 28;

/** One question's progress/report line: glyph, id, status, score, time, cost. */
export const questionLine = (result: QuestionResult): string => {
  const color = STATUS_COLOR[result.status];
  const glyph = color(GLYPH[result.status]);
  const id = result.id.padEnd(ID_PAD);
  if (result.status === "skip") {
    return `  ${glyph} ${id} ${colors.dim("skipped")}`;
  }
  const score = result.score === undefined ? "" : result.score.toFixed(2);
  const cost = money(result.costUsd);
  const cells = [
    color(result.status),
    score,
    colors.dim(seconds(result.durationMs)),
    cost === "" ? "" : colors.dim(cost),
  ]
    .filter((cell) => cell !== "")
    .join("  ");
  return `  ${glyph} ${id} ${cells}`;
};

/** Indented context under a question's line: missing facts, error detail. */
export const questionDetails = (
  result: QuestionResult,
  verbose: boolean
): string[] => {
  const lines: string[] = [];
  if (result.status === "fail") {
    for (const fact of result.missing) {
      lines.push(`      ${colors.dim(`missing: ${fact}`)}`);
    }
  }
  if (result.status === "error" && result.detail) {
    lines.push(`      ${colors.dim(result.detail)}`);
  }
  if (verbose && result.answer && result.status !== "pass") {
    lines.push(
      ...result.answer
        .split("\n")
        .map((line) => `      ${colors.dim(`> ${line}`)}`)
    );
  }
  return lines;
};

/** The one-line totals: `9 passed · 2 failed · 1 skipped · 1m 42s · $0.71`. */
export const summaryLine = (result: EvalResult): string => {
  const { counts } = result;
  const parts = [
    `${counts.pass} passed`,
    counts.fail > 0 ? `${counts.fail} failed` : "",
    counts.error > 0 ? `${counts.error} errored` : "",
    counts.skip > 0 ? `${counts.skip} skipped` : "",
    duration(result.durationMs),
    money(result.costUsd),
  ].filter((part) => part !== "");
  return parts.join(" · ");
};

/** The header line the command prints before the first question runs. */
export const headerLine = (total: number, agent: EvalResult["agent"]): string =>
  `${colors.bold("blume eval")}  ${total} question(s) · ${AGENTS[agent].name}`;

/** The dim announce line while a question's agents run. */
export const startLine = (id: string, index: number, total: number): string =>
  `  ${colors.dim(`▸ ${id} (${index + 1}/${total})`)}`;

/** `fix:` pointers for failed questions, naming the file that resolves each. */
export const fixLines = (result: EvalResult, root: string): string[] =>
  result.diagnostics
    .filter((diagnostic) => diagnostic.code !== "BLUME_EVAL_ROUTE_UNKNOWN")
    .map((finding) => {
      const site = finding.file
        ? `${relative(root, finding.file)}${finding.line ? `:${finding.line}` : ""}`
        : "";
      return `  ${colors.cyan("fix:")} ${site} ${colors.dim(finding.message)}`;
    });

/** Dim warnings for route hints that no longer match a page. */
export const warningLines = (result: EvalResult, root: string): string[] =>
  result.diagnostics
    .filter((diagnostic) => diagnostic.code === "BLUME_EVAL_ROUTE_UNKNOWN")
    .map((finding) => {
      const site = finding.file
        ? ` ${relative(root, finding.file)}${finding.line ? `:${finding.line}` : ""}`
        : "";
      return `  ${colors.yellow("⚠")}${site} ${colors.dim(finding.message)}`;
    });

/** The human report, written to stderr by the command. */
export const formatEvalReport = (
  result: EvalResult,
  root: string,
  options: { verbose?: boolean } = {}
): string => {
  const lines: string[] = [headerLine(result.results.length, result.agent), ""];

  for (const question of result.results) {
    lines.push(
      questionLine(question),
      ...questionDetails(question, Boolean(options.verbose))
    );
  }
  lines.push("");

  // The finding tells the author which file fixes which failure.
  const failures = fixLines(result, root);
  lines.push(...failures);
  if (failures.length > 0) {
    lines.push("");
  }

  lines.push(`  ${summaryLine(result)}`, "");
  return lines.join("\n");
};

/**
 * The machine-readable report. The `diagnostics` + `summary` shape matches
 * `blume validate --json` and `blume audit --json` exactly — anything parsing
 * those keeps working — with the eval run's own results alongside.
 */
export const evalReportJson = (
  result: EvalResult,
  root: string,
  threshold: number
): string => {
  const diagnostics = result.diagnostics.map((diagnostic) =>
    diagnostic.file
      ? { ...diagnostic, file: relative(root, diagnostic.file) }
      : diagnostic
  );
  return `${JSON.stringify(
    {
      diagnostics,
      eval: {
        agent: result.agent,
        costUsd: result.costUsd,
        counts: result.counts,
        durationMs: result.durationMs,
        results: result.results,
        threshold,
      },
      summary: countBySeverity(result.diagnostics),
    },
    null,
    2
  )}\n`;
};

/**
 * Write the full JSON report where a `--fix` agent can read it — a file
 * rather than inline prompt text, because a long run's answers would exceed
 * the platform's argv limit.
 */
export const writeEvalReport = async (
  result: EvalResult,
  root: string,
  threshold: number
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-eval-"));
  const path = join(dir, "report.json");
  await writeFile(path, evalReportJson(result, root, threshold));
  return path;
};
