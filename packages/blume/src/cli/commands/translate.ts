import { defineCommand } from "citty";

import { AGENTS } from "../../audit/agent.ts";
import type { AgentKind } from "../../audit/agent.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { i18nEnabled, localeCodes } from "../../core/i18n.ts";
import { scanProject } from "../../core/project-graph.ts";
import type { ResolvedI18nConfig } from "../../core/schema.ts";
import { DEFAULT_TRANSLATE_TIMEOUT_MS } from "../../translate/agents.ts";
import {
  pruneLedger,
  readLedger,
  stampLedger,
  writeLedger,
} from "../../translate/ledger.ts";
import {
  checkLines,
  checkReportJson,
  checkSummaryLine,
  createProgressRenderer,
  diagnosticLines,
  hasDrift,
  translateHeaderLine,
  translateReportJson,
  translateSummaryLine,
} from "../../translate/report.ts";
import { runTranslate } from "../../translate/run.ts";
import { computeWorkList } from "../../translate/work-list.ts";
import { reportInternalError } from "../internal-error.ts";
import { flushStdout, logger } from "../log.ts";

/** Wall-clock ceiling per file, in seconds. */
const DEFAULT_TIMEOUT_S = DEFAULT_TRANSLATE_TIMEOUT_MS / 1000;

interface TranslateFlags {
  check?: boolean;
  claude?: boolean;
  codex?: boolean;
  force?: boolean;
  json?: boolean;
  locale?: string;
  timeout?: string;
}

/** Validate the flag surface, exiting with a message on the first offense. */
const parseFlags = (
  args: TranslateFlags
): { agent: AgentKind | undefined; timeoutS: number } => {
  const agents = (Object.keys(AGENTS) as AgentKind[]).filter(
    (kind) => args[kind]
  );
  if (agents.length > 1) {
    logger.error("Pass exactly one of --claude or --codex.");
    process.exit(1);
  }
  if (args.check && agents.length > 0) {
    logger.error(
      "--check is read-only and never runs an agent; drop --claude/--codex."
    );
    process.exit(1);
  }
  if (!args.check && agents.length === 0) {
    logger.error(
      "Pass --claude or --codex to choose the agent CLI that translates."
    );
    process.exit(1);
  }
  const timeoutS =
    args.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(args.timeout);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) {
    logger.error(`Invalid --timeout "${args.timeout}" (whole seconds).`);
    process.exit(1);
  }
  return { agent: agents[0], timeoutS };
};

/**
 * Resolve `--locale` against the configured locales: comma-separated,
 * case-insensitive, adopting the configured casing. Unknown codes and the
 * default locale (the translation source) are errors.
 */
const parseLocales = (
  value: string | undefined,
  i18n: ResolvedI18nConfig
): string[] | undefined => {
  if (value === undefined) {
    return;
  }
  const configured = new Map(
    i18n.locales.map((locale) => [locale.code.toLowerCase(), locale.code])
  );
  const resolved: string[] = [];
  for (const part of value.split(",")) {
    const code = configured.get(part.trim().toLowerCase());
    if (code === undefined) {
      logger.error(
        `Unknown --locale "${part.trim()}" (configured: ${localeCodes(i18n).join(", ")}).`
      );
      process.exit(1);
    }
    if (code === i18n.defaultLocale) {
      logger.error(
        `--locale "${code}" is the default locale — it is the translation source, not a target.`
      );
      process.exit(1);
    }
    resolved.push(code);
  }
  return resolved;
};

const notInstalled = (agent: AgentKind): never => {
  const cli = AGENTS[agent];
  logger.error(
    `${cli.name} (\`${cli.bin}\`) was not found on PATH. Install it with \`${cli.install}\`.`
  );
  return process.exit(1);
};

export const translateCommand = defineCommand({
  args: {
    check: {
      description:
        "Report missing/stale translations without writing anything; exits 1 on drift (for CI).",
      type: "boolean",
    },
    claude: {
      description: "Translate with Claude Code.",
      type: "boolean",
    },
    codex: {
      description: "Translate with Codex.",
      type: "boolean",
    },
    force: {
      description:
        "Retranslate everything, up-to-date and hand-authored files included.",
      type: "boolean",
    },
    json: {
      description: "Emit the report as JSON on stdout (for CI/editors).",
      type: "boolean",
    },
    locale: {
      description:
        "Comma-separated target locale codes; defaults to every non-default locale.",
      type: "string",
    },
    timeout: {
      description: `Agent time limit per file, in seconds. Defaults to ${DEFAULT_TIMEOUT_S}.`,
      type: "string",
    },
  },
  meta: {
    description:
      "Translate docs into the configured locales with a local agent CLI.",
    name: "translate",
  },
  async run({ args }) {
    const root = process.cwd();
    const { agent, timeoutS } = parseFlags(args);

    try {
      // `scanProject`, not `prepareProject`: translation reads the content
      // tree and writes source files, never `.blume/`, so it doesn't contend
      // with a running dev server. Same reasoning as `blume audit`/`eval`.
      const project = await scanProject(root, { mode: "build" });
      if (!i18nEnabled(project.config)) {
        logger.error(
          "i18n is not configured — add `i18n.locales` to blume.config to use `blume translate`."
        );
        process.exit(1);
      }
      const { i18n } = project.config;
      if (localeCodes(i18n).every((code) => code === i18n.defaultLocale)) {
        logger.error(
          "i18n.locales has no locale besides the default — nothing to translate into."
        );
        process.exit(1);
      }
      const locales = parseLocales(args.locale, i18n);
      const ledger = await readLedger(root);
      const workList = await computeWorkList(project, ledger, {
        force: !args.check && Boolean(args.force),
        locales,
      });

      if (args.check) {
        const lines = [
          ...diagnosticLines(workList.diagnostics),
          ...checkLines(workList),
          "",
          `  ${checkSummaryLine(workList)}`,
          "",
        ];
        process.stderr.write(`${lines.join("\n")}\n`);
        if (args.json) {
          process.stdout.write(checkReportJson(workList));
        }
        if (hasDrift(workList)) {
          await flushStdout();
          process.exit(1);
        }
        return;
      }

      const kind = agent as AgentKind;
      process.stderr.write(
        `${translateHeaderLine(workList.items.length, workList.targetLocales.length, kind)}\n\n`
      );
      const renderer = createProgressRenderer({
        isTTY: process.stderr.isTTY === true,
        write: (chunk) => process.stderr.write(chunk),
      });
      const result = await runTranslate({
        agent: kind,
        ledger,
        onProgress: (event) => renderer.onProgress(event),
        project,
        timeoutMs: timeoutS * 1000,
        workList,
      });
      renderer.stop();

      // Adopt pre-existing hand-authored translations (stamp, never rewrite),
      // then prune entries whose source or locale no longer exists. Pruning
      // spans ALL non-default locales — a `--locale fr` run must not drop the
      // other locales' stamps.
      for (const entry of workList.untracked) {
        stampLedger(ledger, entry.sourceRel, entry.locale, entry.hash);
      }
      const knownLocales = new Set(
        localeCodes(i18n).filter((code) => code !== i18n.defaultLocale)
      );
      await writeLedger(
        root,
        pruneLedger(ledger, workList.knownSources, knownLocales)
      );

      const tail = [
        "",
        ...diagnosticLines(workList.diagnostics),
        `  ${translateSummaryLine(result, workList)}`,
        "",
      ];
      process.stderr.write(tail.join("\n"));

      if (args.json) {
        process.stdout.write(translateReportJson(result, workList));
      }
      if (result.counts.failed > 0 || result.counts.partial > 0) {
        // The ledger write above already persisted every success, so a failed
        // rerun only retries what actually failed.
        await flushStdout();
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof BlumeError) {
        logger.error(error.diagnostic.message);
        process.exit(1);
      }
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && agent) {
        notInstalled(agent);
      }
      reportInternalError(error);
      process.exit(1);
    }
  },
});
