import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import { join } from "pathe";

import {
  customStaticRoutes,
  discoverPages,
  hasGeneratedChangelog,
} from "../../astro/pages.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { validateLinks } from "../../core/links.ts";
import { buildManifest } from "../../core/manifest.ts";
import { scanProject } from "../../core/project-graph.ts";
import type { Diagnostic } from "../../core/types.ts";
import { commandMeta } from "../command-meta.ts";
import { reportInternalError } from "../internal-error.ts";
import {
  flushStdout,
  logger,
  reportDiagnostics,
  reportDiagnosticsJson,
} from "../log.ts";

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
  meta: commandMeta.validate,
  async run({ args }) {
    const root = process.cwd();
    const diagnostics: Diagnostic[] = [];

    try {
      const project = await scanProject(root, { mode: "build" });
      // Surface content/graph problems too: a page that fails to parse is a
      // link-validation blind spot, so silently passing would be misleading.
      diagnostics.push(...project.diagnostics);

      // Custom `.astro` pages and the generated changelog index are servable
      // routes the content graph can't see — without them, a docs link to e.g.
      // a custom landing page fails as BLUME_BROKEN_LINK.
      const userPages = project.context.pagesRoot
        ? await discoverPages(project.context.pagesRoot)
        : [];
      const extraRoutes = customStaticRoutes(userPages);
      if (hasGeneratedChangelog(project, userPages)) {
        extraRoutes.push("/changelog");
      }

      // Fallback-materialized locale routes (an untranslated page prerendered
      // at its localized URL) are servable but absent from the content graph —
      // without them a link to an untranslated sibling under a non-default
      // locale fails as BLUME_BROKEN_LINK even though the built site serves it.
      if (project.config.i18n) {
        const manifest = buildManifest({
          config: project.config,
          context: project.context,
          graph: project.graph,
        });
        extraRoutes.push(
          ...manifest.routes.flatMap((route) =>
            route.fallback ? [route.path] : []
          )
        );
      }

      const publicDir = join(root, "public");
      diagnostics.push(
        ...(await validateLinks(project.graph, {
          basePath: project.config.basePath,
          checkExternal: Boolean(args.external),
          extraRoutes,
          i18n: project.config.i18n,
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

    // `--strict` escalates warnings to failures; info-level notes (e.g.
    // BLUME_ASSETS_UNCHECKED when there is no public/ dir) stay advisory.
    const strictFailure =
      Boolean(args.strict) &&
      diagnostics.some((diagnostic) => diagnostic.severity !== "info");

    if (args.json) {
      // Drain stdout before exiting non-zero: `process.exit` would otherwise
      // truncate the JSON payload mid-write when stdout is a pipe — exactly how
      // `--json` is consumed in CI/editors.
      const hadErrors = reportDiagnosticsJson(diagnostics, root);
      if (hadErrors || strictFailure) {
        await flushStdout();
        process.exit(1);
      }
      return;
    }

    const hadErrors = reportDiagnostics(diagnostics, root);
    if (diagnostics.length === 0) {
      logger.success("No broken links found.");
    }
    if (hadErrors || strictFailure) {
      // Set the code and return rather than `process.exit`, which doesn't wait
      // for a piped stderr: a long diagnostic list would be cut off.
      process.exitCode = 1;
    }
  },
});
