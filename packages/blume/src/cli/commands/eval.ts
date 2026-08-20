import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import { join } from "pathe";

import { AGENTS, launchAgent } from "../../audit/agent.ts";
import type { AgentKind } from "../../audit/agent.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { scanProject } from "../../core/project-graph.ts";
import { evalFixPrompt, initPrompt } from "../../eval/prompts.ts";
import {
  evalReportJson,
  fixLines,
  headerLine,
  questionDetails,
  questionLine,
  startLine,
  summaryLine,
  warningLines,
  writeEvalReport,
} from "../../eval/report.ts";
import { runEval } from "../../eval/run.ts";
import type { EvalResult } from "../../eval/run.ts";
import { EvalsFileError, loadEvalsFile } from "../../eval/schema.ts";
import { reportInternalError } from "../internal-error.ts";
import { flushStdout, logger } from "../log.ts";

const DEFAULT_FILE = "evals.yaml";

/** Reader wall-clock ceiling per question, in seconds. */
const DEFAULT_TIMEOUT_S = 180;

const isAgentKind = (value: string): value is AgentKind => value in AGENTS;

/**
 * Launch the interactive agent CLI, turning a missing executable into the
 * install hint. Only `ENOENT` means "not installed" — any other spawn failure
 * (`EACCES`, `EMFILE`, …) must surface as itself.
 */
const notInstalled = (agent: AgentKind): never => {
  const cli = AGENTS[agent];
  logger.error(
    `${cli.name} (\`${cli.bin}\`) was not found on PATH. Install it with \`${cli.install}\`.`
  );
  return process.exit(1);
};

const launchAgentCode = async (
  agent: AgentKind,
  prompt: string
): Promise<number> => {
  try {
    return await launchAgent(AGENTS[agent].bin, prompt);
  } catch (error) {
    // SAFETY: only the `code` tag is inspected; a spawn failure throws an
    // ErrnoException, and any other thrown value fails the comparison and
    // rethrows unchanged.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    return notInstalled(agent);
  }
};

/** The fraction of run (non-skipped) questions that passed. */
export const passFraction = (result: EvalResult): number => {
  const ran = result.results.length - result.counts.skip;
  return ran === 0 ? 1 : result.counts.pass / ran;
};

interface EvalFlags {
  action?: string;
  agent: string;
  file: string;
  fix?: boolean;
  json?: boolean;
  threshold?: string;
  timeout?: string;
}

/** Validate the flag surface, exiting with a message on the first offense. */
const parseFlags = (args: EvalFlags) => {
  if (!isAgentKind(args.agent)) {
    logger.error(`Invalid --agent "${args.agent}" (use claude | codex).`);
    process.exit(1);
  }
  if (args.action !== undefined && args.action !== "init") {
    logger.error(`Unknown action "${args.action}" (did you mean "init"?).`);
    process.exit(1);
  }
  if (args.json && args.fix) {
    logger.error("--json and --fix are mutually exclusive.");
    process.exit(1);
  }
  const threshold = args.threshold === undefined ? 1 : Number(args.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    logger.error(`Invalid --threshold "${args.threshold}" (use 0..1).`);
    process.exit(1);
  }
  const timeoutS =
    args.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(args.timeout);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) {
    logger.error(`Invalid --timeout "${args.timeout}" (whole seconds).`);
    process.exit(1);
  }
  return { agent: args.agent, threshold, timeoutS };
};

/** `blume eval --fix`: hand the failing report to the interactive agent. */
const runFixHandoff = async (
  agent: AgentKind,
  result: EvalResult,
  root: string,
  threshold: number
): Promise<void> => {
  const count = result.counts.fail + result.counts.error;
  if (count === 0) {
    return;
  }
  const cli = AGENTS[agent];
  const report = await writeEvalReport(result, root, threshold);
  process.stderr.write(
    `  Handing ${count} failed question${count === 1 ? "" : "s"} to ${cli.name}…\n\n`
  );
  const code = await launchAgentCode(agent, evalFixPrompt(report));
  if (code !== 0) {
    process.exit(code);
  }
};

/** `blume eval init`: draft a starter evals file via the interactive agent. */
const runInit = async (agent: AgentKind, file: string): Promise<void> => {
  const path = join(process.cwd(), file);
  if (existsSync(path)) {
    logger.error(
      `${file} already exists — edit it directly, or pass --file to draft elsewhere.`
    );
    process.exit(1);
  }
  const code = await launchAgentCode(agent, initPrompt(file));
  if (code !== 0) {
    process.exit(code);
  }
};

export const evalCommand = defineCommand({
  args: {
    action: {
      description: 'Optional action: "init" drafts a starter evals file.',
      required: false,
      type: "positional",
    },
    agent: {
      default: "claude",
      description: "Agent CLI that reads and grades the docs: claude | codex.",
      type: "string",
    },
    file: {
      default: DEFAULT_FILE,
      description: "The evals file to run.",
      type: "string",
    },
    fix: {
      description:
        "After a failing run, hand the report to the agent to fix the docs interactively.",
      type: "boolean",
    },
    json: {
      description: "Emit the report as JSON on stdout (for CI/editors).",
      type: "boolean",
    },
    threshold: {
      description:
        "Minimum passing fraction (0..1) before the run exits non-zero. Defaults to 1.",
      type: "string",
    },
    timeout: {
      description: `Reader time limit per question, in seconds. Defaults to ${DEFAULT_TIMEOUT_S}.`,
      type: "string",
    },
    verbose: {
      description: "Include the reader's full answer under each failure.",
      type: "boolean",
    },
  },
  meta: {
    description:
      "Test the docs: an agent answers your questions using only the documentation.",
    name: "eval",
  },
  async run({ args }) {
    const root = process.cwd();
    const { agent, threshold, timeoutS } = parseFlags(args);
    if (args.action === "init") {
      await runInit(agent, args.file);
      return;
    }

    let result: EvalResult;
    try {
      // `scanProject`, not `prepareProject`: the eval reads the content tree
      // and never regenerates the runtime, so it doesn't contend with a
      // running dev server. Same reasoning as `blume audit`.
      const project = await scanProject(root, { mode: "build" });
      const evalsPath = join(root, args.file);
      const { evals, raw } = await loadEvalsFile(evalsPath);

      process.stderr.write(`${headerLine(evals.questions.length, agent)}\n\n`);
      result = await runEval({
        agent,
        evals,
        evalsPath,
        onProgress: (event) => {
          // Straight to stderr, not `logger.info` — consola drops info-level
          // lines in test and CI environments.
          if (event.kind === "question-start") {
            process.stderr.write(
              `${startLine(event.id, event.index, event.total)}\n`
            );
            return;
          }
          const lines = [
            questionLine(event.result),
            ...questionDetails(event.result, Boolean(args.verbose)),
          ];
          process.stderr.write(`${lines.join("\n")}\n`);
        },
        project,
        rawEvals: raw,
        readerTimeoutMs: timeoutS * 1000,
      });
    } catch (error) {
      if (error instanceof EvalsFileError) {
        logger.error(error.message);
        process.exit(1);
      }
      if (error instanceof BlumeError) {
        logger.error(error.diagnostic.message);
        process.exit(1);
      }
      // SAFETY: only the `code` tag is inspected; a spawn failure throws an
      // ErrnoException, and any other thrown value fails the comparison and
      // falls through to the internal-error report.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        notInstalled(agent);
      }
      reportInternalError(error);
      process.exit(1);
    }

    const tail = [
      "",
      ...warningLines(result, root),
      ...fixLines(result, root),
      "",
      `  ${summaryLine(result)}`,
      "",
    ];
    process.stderr.write(tail.join("\n"));

    const failed = passFraction(result) < threshold;

    if (args.fix) {
      // The gate is a CI concern; a handoff run succeeds when the agent
      // session does, not when the docs already passed.
      await runFixHandoff(agent, result, root, threshold);
      return;
    }

    if (args.json) {
      process.stdout.write(evalReportJson(result, root, threshold));
      if (failed) {
        // `process.exit` doesn't flush a piped stdout — without this the JSON
        // is truncated mid-write in exactly the CI setups that consume it.
        await flushStdout();
        process.exit(1);
      }
      return;
    }

    if (failed) {
      process.exit(1);
    }
  },
});
