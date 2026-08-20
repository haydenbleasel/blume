import { readFileSync } from "node:fs";

import { defineCommand } from "citty";
import { join } from "pathe";
import { satisfies } from "semver";

import { BlumeError } from "../../core/diagnostics.ts";
import { packageRoot } from "../../core/package-root.ts";
import { scanProject } from "../../core/project-graph.ts";
import { serverFeatures } from "../../core/server-features.ts";
import type { Diagnostic } from "../../core/types.ts";
import { reportInternalError } from "../internal-error.ts";
import {
  flushStdout,
  logger,
  reportDiagnostics,
  reportDiagnosticsJson,
} from "../log.ts";

const FALLBACK_NODE_RANGE = ">=22.12.0";

/** The supported Node range, read from the package's own `engines` field so
 * doctor can never drift from what the package actually declares. */
const supportedNodeRange = (): string => {
  try {
    // SAFETY: this parses blume's own package.json; the optional fields cover
    // an `engines` block going missing, and a bad read falls to the catch.
    const pkg = JSON.parse(
      readFileSync(join(packageRoot(), "package.json"), "utf-8")
    ) as { engines?: { node?: string } };
    return pkg.engines?.node || FALLBACK_NODE_RANGE;
  } catch {
    return FALLBACK_NODE_RANGE;
  }
};

export const doctorCommand = defineCommand({
  args: {
    json: {
      description: "Emit diagnostics as JSON on stdout (for CI/editors).",
      type: "boolean",
    },
  },
  meta: {
    description: "Diagnose common configuration and content problems.",
    name: "doctor",
  },
  async run({ args }) {
    const root = process.cwd();
    const diagnostics: Diagnostic[] = [];

    const nodeRange = supportedNodeRange();
    if (!satisfies(process.versions.node, nodeRange)) {
      diagnostics.push({
        code: "BLUME_NODE_VERSION",
        message: `Node ${process.versions.node} is outside the supported range (${nodeRange}).`,
        severity: "warning",
      });
    }

    try {
      const project = await scanProject(root, { mode: "build" });
      diagnostics.push(...project.diagnostics);

      const { config } = project;
      const features = serverFeatures(config);
      if (features.length > 0 && config.deployment.output === "static") {
        diagnostics.push({
          code: "BLUME_SERVER_FEATURE_REQUIRED",
          message: `${features.join(", ")} require server output.`,
          severity: "error",
          suggestion: 'Set deployment.output to "server".',
        });
      }
      if (config.deployment.output === "server" && !config.deployment.adapter) {
        diagnostics.push({
          code: "BLUME_ADAPTER_REQUIRED",
          message: "Server output requires an adapter.",
          severity: "error",
          suggestion: 'Set deployment.adapter (e.g. "vercel").',
        });
      }

      if (!args.json) {
        logger.info(`Pages: ${project.graph.pages.length}`);
        logger.info(`Output: ${config.deployment.output}`);
        logger.info(`Search: ${config.search.provider}`);
      }
    } catch (error) {
      if (error instanceof BlumeError) {
        diagnostics.push(error.diagnostic);
      } else {
        reportInternalError(error);
        process.exit(1);
      }
    }

    if (args.json) {
      // Drain stdout before exiting non-zero: `process.exit` would otherwise
      // truncate the JSON payload mid-write when stdout is a pipe — exactly how
      // `--json` is consumed in CI/editors.
      if (reportDiagnosticsJson(diagnostics, root)) {
        await flushStdout();
        process.exit(1);
      }
      return;
    }

    const hadErrors = reportDiagnostics(diagnostics, root);
    if (diagnostics.length === 0) {
      logger.success("No problems found.");
    }
    if (hadErrors) {
      process.exit(1);
    }
  },
});
