import { defineCommand } from "citty";

import { BlumeError } from "../../core/diagnostics.ts";
import { scanProject } from "../../core/project-graph.ts";
import { serverFeatures } from "../../core/server-features.ts";
import type { Diagnostic } from "../../core/types.ts";
import { reportInternalError } from "../internal-error.ts";
import { logger, reportDiagnostics, reportDiagnosticsJson } from "../log.ts";

const MIN_NODE_MAJOR = 20;

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

    const nodeMajor = Number.parseInt(
      process.versions.node.split(".")[0] ?? "0",
      10
    );
    if (nodeMajor < MIN_NODE_MAJOR) {
      diagnostics.push({
        code: "BLUME_NODE_VERSION",
        message: `Node ${process.versions.node} is below the supported minimum (${MIN_NODE_MAJOR}).`,
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
      if (reportDiagnosticsJson(diagnostics, root)) {
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
