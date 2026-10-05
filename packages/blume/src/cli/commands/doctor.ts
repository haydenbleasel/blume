import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { defineCommand } from "citty";
import { join } from "pathe";
import { satisfies } from "semver";

import { discoverExamples } from "../../astro/examples.ts";
import { discoverIslands } from "../../astro/islands.ts";
import { discoverPages, navTargetRoutes } from "../../astro/pages.ts";
import { missingDependencyDiagnostic } from "../../astro/runtime-deps.ts";
import { missingExampleDiagnostics } from "../../core/component-diagnostics.ts";
import {
  analyzeComponentOverrides,
  ComponentOverridesError,
} from "../../core/component-overrides.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { validateNavTargets } from "../../core/nav-diagnostics.ts";
import { packageRoot } from "../../core/package-root.ts";
import { scanProject } from "../../core/project-graph.ts";
import type { ResolvedConfig } from "../../core/schema.ts";
import { serverFeatures } from "../../core/server-features.ts";
import type { Diagnostic } from "../../core/types.ts";
import { unregisteredSnapshotDiagnostics } from "../../core/version-cut.ts";
import { commandMeta } from "../command-meta.ts";
import { loadEnvFiles } from "../env.ts";
import { reportInternalError } from "../internal-error.ts";
import {
  flushStdout,
  logger,
  reportDiagnostics,
  reportDiagnosticsJson,
} from "../log.ts";
import { checkRequiredSecrets } from "../required-secrets.ts";

const FALLBACK_NODE_RANGE = ">=22.12.0";

/**
 * Plan `components.ts` the way `blume dev`/`build` do, reporting each override
 * that can't be planned — a non-static form, or an import of a file that
 * doesn't exist — with its own line. The scan alone never reads the file, so
 * without this doctor would pass a project whose build fails. Also returns
 * the MDX tags the file overrides.
 */
const componentsDiagnostics = async (
  componentsFile: string | null
): Promise<{ issues: Diagnostic[]; mdx: string[] }> => {
  if (!componentsFile) {
    return { issues: [], mdx: [] };
  }
  try {
    const { mdx } = analyzeComponentOverrides(
      await readFile(componentsFile, "utf-8"),
      componentsFile
    );
    return { issues: [], mdx: mdx.map((entry) => entry.key) };
  } catch (error) {
    if (error instanceof ComponentOverridesError) {
      return { issues: error.issues, mdx: [] };
    }
    throw error;
  }
};

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

/** The adapters a project runs, one line per kind, for the doctor summary. */
const integrationSummary = (config: ResolvedConfig): string[] => {
  const { assistant } = config.ai;
  let assistantSummary = "off";
  if (assistant?.enabled) {
    assistantSummary = assistant.endpoint
      ? "external endpoint"
      : assistant.provider.kind;
  }
  return [
    `References: ${config.reference.map((adapter) => adapter.kind).join(", ") || "none"}`,
    `Analytics: ${config.analytics.map((adapter) => adapter.kind).join(", ") || "none"}`,
    `Consent: ${config.consent?.kind ?? "none"}`,
    `Rate limiting: ${config.rateLimit?.kind ?? "off"}`,
    `Sources: ${config.content.sources.map((source) => source.kind).join(", ")}`,
    `Assistant: ${assistantSummary}`,
  ];
};

export const doctorCommand = defineCommand({
  args: {
    json: {
      description: "Emit diagnostics as JSON on stdout (for CI/editors).",
      type: "boolean",
    },
  },
  meta: commandMeta.doctor,
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

    // Read `.env` files first, as `blume dev`/`build` do: remote sources read
    // their tokens during the scan, and the secrets check below reads them too.
    loadEnvFiles(root);

    try {
      const project = await scanProject(root, {
        // A missing secret fails at the first request. Checked before the
        // sources fetch, so it's still reported when one of them fails the
        // scan for want of it.
        beforeSources: (config) => {
          diagnostics.push(...checkRequiredSecrets(config));
        },
        mode: "build",
      });
      // Tabs, selector items, and featured links can point at custom pages
      // and generated routes too, so they're checked against every route
      // the site serves, as `blume dev`/`build` check them.
      const userPages = project.context.pagesRoot
        ? await discoverPages(project.context.pagesRoot)
        : [];
      diagnostics.push(
        ...project.diagnostics,
        ...unregisteredSnapshotDiagnostics(project),
        ...validateNavTargets(
          project.graph.navigation,
          navTargetRoutes(project, userPages)
        )
      );

      const { config } = project;
      // The packages a build would need: an adapter's missing SDK fails the
      // build.
      const { islands } = await discoverIslands(root);
      const dependencies = await missingDependencyDiagnostic(
        config,
        root,
        "error",
        islands.map((island) => island.framework)
      );
      if (dependencies) {
        diagnostics.push(dependencies);
      }
      const overrides = await componentsDiagnostics(
        project.context.componentsFile
      );
      diagnostics.push(
        ...overrides.issues,
        // A `<Component path>` naming no example renders a "No example
        // found" box, which dev and build warn about too.
        ...missingExampleDiagnostics(
          project.graph.pages,
          await discoverExamples(root, config.examples.source),
          root,
          new Set([...islands.map((island) => island.name), ...overrides.mdx])
        )
      );
      const features = serverFeatures(config);
      if (
        features.length > 0 &&
        config.deployment.options.output === "static"
      ) {
        // A host adapter already names the target, so only its
        // `output: "static"` stands in the way; otherwise name one.
        const { kind } = config.deployment;
        diagnostics.push({
          code: "BLUME_SERVER_FEATURE_REQUIRED",
          message: `${features.join(", ")} ${features.length === 1 ? "requires" : "require"} server output.`,
          severity: "error",
          suggestion:
            kind === "static"
              ? 'Set deployment to a host adapter from "blume/deploy" (e.g. `deployment: vercel()`).'
              : `Drop \`output: "static"\` from \`deployment: ${kind}()\` to build for the server.`,
        });
      }

      if (!args.json) {
        logger.info(`Pages: ${project.graph.pages.length}`);
        logger.info(`Output: ${config.deployment.options.output}`);
        logger.info(`Adapter: ${config.deployment.kind}`);
        logger.info(`Search: ${config.search.provider.kind}`);
        for (const line of integrationSummary(config)) {
          logger.info(line);
        }
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
      // Set the code and return rather than `process.exit`, which doesn't wait
      // for a piped stderr: a long diagnostic list would be cut off.
      process.exitCode = 1;
    }
  },
});
