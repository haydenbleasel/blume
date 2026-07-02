import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import { join } from "pathe";

import { BlumeError } from "../../core/diagnostics.ts";
import { validateLinks } from "../../core/links.ts";
import { scanProject } from "../../core/project-graph.ts";
import type { Diagnostic } from "../../core/types.ts";
import { reportInternalError } from "../internal-error.ts";
import { logger, reportDiagnostics, reportDiagnosticsJson } from "../log.ts";

export const validateCommand = defineCommand({
  args: {
    external: {
      description: "Check external (HTTP) links over the network.",
      type: "boolean",
    },
    json: {
      description: "Emit diagnostics as JSON on stdout (for CI/editors).",
      type: "boolean",
    },
    strict: {
      description: "Treat warnings as errors.",
      type: "boolean",
    },
  },
  meta: {
    description: "Validate internal, anchor, asset, and external links.",
    name: "validate",
  },
  async run({ args }) {
    const root = process.cwd();
    const diagnostics: Diagnostic[] = [];

    try {
      const project = await scanProject(root, { mode: "build" });
      // Surface content/graph problems too: a page that fails to parse is a
      // link-validation blind spot, so silently passing would be misleading.
      diagnostics.push(...project.diagnostics);

      const publicDir = join(root, "public");
      diagnostics.push(
        ...(await validateLinks(project.graph, {
          checkExternal: Boolean(args.external),
          publicDir: existsSync(publicDir) ? publicDir : null,
          redirects: project.config.redirects,
        }))
      );
    } catch (error) {
      if (error instanceof BlumeError) {
        diagnostics.push(error.diagnostic);
      } else {
        reportInternalError(error);
        process.exit(1);
      }
    }

    if (args.json) {
      const hadErrors = reportDiagnosticsJson(diagnostics, root);
      if (hadErrors || (Boolean(args.strict) && diagnostics.length > 0)) {
        process.exit(1);
      }
      return;
    }

    const hadErrors = reportDiagnostics(diagnostics, root);
    if (diagnostics.length === 0) {
      logger.success("No broken links found.");
    }
    if (hadErrors || (Boolean(args.strict) && diagnostics.length > 0)) {
      process.exit(1);
    }
  },
});
