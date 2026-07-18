import { defineCommand } from "citty";

import {
  AGENTS,
  fixPrompt,
  launchAgent,
  writeAgentReport,
} from "../../audit/agent.ts";
import type { AgentKind } from "../../audit/agent.ts";
import { formatCatalog, formatReport, reportJson } from "../../audit/report.ts";
import { NoBuildError, runAudit } from "../../audit/run.ts";
import type { AuditResult } from "../../audit/run.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { scanProject } from "../../core/project-graph.ts";
import type { DiagnosticSeverity } from "../../core/types.ts";
import { reportInternalError } from "../internal-error.ts";
import { flushStdout, logger } from "../log.ts";

const SEVERITIES: DiagnosticSeverity[] = ["error", "warning", "info"];

/** Severities at or above the gate, e.g. `warning` -> error + warning. */
const failingSeverities = (gate: DiagnosticSeverity): Set<DiagnosticSeverity> =>
  new Set(SEVERITIES.slice(0, SEVERITIES.indexOf(gate) + 1));

const splitTerms = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((term) => term.trim())
        .filter(Boolean)
    : [];

/** Whether the run should exit non-zero, given the gate. */
export const shouldFail = (
  result: AuditResult,
  gate: DiagnosticSeverity
): boolean => {
  const failing = failingSeverities(gate);
  return result.diagnostics.some((d) => failing.has(d.severity));
};

export const auditCommand = defineCommand({
  args: {
    claude: {
      description: "Hand the findings to Claude Code to fix interactively.",
      type: "boolean",
    },
    codex: {
      description: "Hand the findings to Codex to fix interactively.",
      type: "boolean",
    },
    external: {
      description: "Probe outbound links over the network.",
      type: "boolean",
    },
    "fail-on": {
      description:
        "Exit non-zero at this severity or above: error | warning | info. Defaults to error.",
      type: "string",
    },
    json: {
      description: "Emit the report as JSON on stdout (for CI/editors).",
      type: "boolean",
    },
    "list-checks": {
      description: "Print every check the audit can report, then exit.",
      type: "boolean",
    },
    only: {
      description: "Only report these checks or categories (comma-separated).",
      type: "string",
    },
    skip: {
      description: "Suppress these checks or categories (comma-separated).",
      type: "string",
    },
    strict: {
      description: "Alias for --fail-on warning.",
      type: "boolean",
    },
    url: {
      description:
        "Also probe a live deployment (e.g. https://docs.example.com) for status codes, headers, and redirects.",
      type: "string",
    },
    verbose: {
      description: "List every affected page instead of the first few.",
      type: "boolean",
    },
  },
  meta: {
    description: "Audit the built site for SEO and site-health issues.",
    name: "audit",
  },
  async run({ args }) {
    if (args["list-checks"]) {
      process.stdout.write(formatCatalog());
      return;
    }

    const root = process.cwd();
    const gate = (args["fail-on"] ??
      (args.strict ? "warning" : "error")) as DiagnosticSeverity;
    if (!SEVERITIES.includes(gate)) {
      logger.error(
        `Invalid --fail-on "${gate}" (use ${SEVERITIES.join(" | ")}).`
      );
      process.exit(1);
    }
    const agents = (Object.keys(AGENTS) as AgentKind[]).filter(
      (kind) => args[kind]
    );
    if (agents.length > 1) {
      logger.error("Pass at most one of --claude or --codex.");
      process.exit(1);
    }
    const [agent] = agents;
    if (agent && args.json) {
      logger.error(`--json and --${agent} are mutually exclusive.`);
      process.exit(1);
    }
    let result: AuditResult;
    try {
      // `scanProject`, not `prepareProject`: the audit reads the *existing*
      // build and never regenerates the runtime, so it doesn't contend with a
      // running dev server. Same reasoning as `blume validate`.
      const project = await scanProject(root, { mode: "build" });
      result = await runAudit({
        external: args.external,
        only: splitTerms(args.only),
        origin: args.url,
        project,
        skip: splitTerms(args.skip),
      });
    } catch (error) {
      if (error instanceof NoBuildError) {
        logger.error(`${error.message} Run \`blume build\` first.`);
        process.exit(1);
      }
      if (error instanceof BlumeError) {
        logger.error(error.diagnostic.message);
        process.exit(1);
      }
      reportInternalError(error);
      process.exit(1);
    }

    if (agent) {
      // Show the same report a plain run would, so the terminal records what
      // was handed off before the agent's own UI takes over the screen.
      process.stderr.write(
        formatReport(result, root, { verbose: args.verbose })
      );
      if (result.diagnostics.length === 0) {
        return;
      }
      const cli = AGENTS[agent];
      const report = await writeAgentReport(result, root);
      const count = result.diagnostics.length;
      // Straight to stderr like the report above it, not `logger.info` —
      // consola drops info-level lines in test and CI environments.
      process.stderr.write(
        `  Handing ${count} finding${count === 1 ? "" : "s"} to ${cli.name}…\n\n`
      );
      let code: number;
      try {
        code = await launchAgent(cli.bin, fixPrompt(report));
      } catch {
        logger.error(
          `${cli.name} (\`${cli.bin}\`) was not found on PATH. Install it with \`${cli.install}\`.`
        );
        process.exit(1);
      }
      if (code !== 0) {
        process.exit(code);
      }
      // The gate is a CI concern; a handoff run succeeds when the agent
      // session does, not when the pre-fix site was already clean.
      return;
    }

    if (args.json) {
      process.stdout.write(reportJson(result, root));
      if (shouldFail(result, gate)) {
        // `process.exit` doesn't flush a piped stdout — without this the JSON is
        // truncated mid-write in exactly the CI setups that consume it.
        await flushStdout();
        process.exit(1);
      }
      return;
    }

    process.stderr.write(formatReport(result, root, { verbose: args.verbose }));

    if (shouldFail(result, gate)) {
      process.exit(1);
    }
  },
});
