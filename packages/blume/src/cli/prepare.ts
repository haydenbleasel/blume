import { generateRuntime } from "../astro/generate.ts";
import { BlumeError, hasErrors } from "../core/diagnostics.ts";
import { scanProject } from "../core/project-graph.ts";
import type {
  BlumeProject,
  BuildMode,
  ConfigOverrides,
} from "../core/project-graph.ts";
import { serverFeatures } from "../core/server-features.ts";
import { loadEnvFiles } from "./env.ts";
import { reportInternalError } from "./internal-error.ts";
import { logger, reportDiagnostics } from "./log.ts";
import { checkRequiredSecrets } from "./required-secrets.ts";
import { yarnPnpDiagnostic } from "./yarn-pnp.ts";

export interface PrepareOptions {
  root: string;
  mode?: BuildMode;
  strict?: boolean;
  /**
   * Whether the command is strict only on request (`blume check --strict`),
   * which changes how the abort message says to continue. Defaults to true in
   * dev mode (`blume dev`, `blume sync`) and false otherwise, where strict is
   * the default a user turns off with `--no-strict` (`blume build`).
   */
  strictOptIn?: boolean;
  /** Local dev server URL, used as the `deployment.site` fallback (dev only). */
  devServerUrl?: string;
  /** Render drafts and fetch unpublished CMS content. */
  preview?: boolean;
  /** Force remote sources to re-fetch instead of serving the cached snapshot. */
  refresh?: boolean;
  /** CLI config overrides (e.g. `--output`, `--content-dir`). */
  overrides?: ConfigOverrides;
  /** Relocate the generated runtime (e.g. `.blume-verify` for `--isolated`). */
  runtimeDir?: string;
}

/**
 * Scan the project, surface diagnostics, and (re)generate the `.blume` runtime.
 * In strict mode, any error aborts. Returns the resolved project.
 */
export const prepareProject = async (
  options: PrepareOptions
): Promise<BlumeProject> => {
  // Under Yarn Plug'n'Play the generated runtime can't resolve anything; say
  // so before scanning, instead of failing inside Astro's config load.
  const pnp = yarnPnpDiagnostic(options.root);
  if (pnp) {
    reportDiagnostics([pnp], options.root);
    process.exit(1);
  }

  // Load `.env` files from the project root before the scan: remote sources
  // read their tokens from `process.env` during `scanProject`, and
  // `loadEnvFiles` never overrides variables that are already set.
  loadEnvFiles(options.root);

  let project: BlumeProject;
  try {
    project = await scanProject(options.root, {
      // Fail-fast on missing secrets: warn now, not at the first request, and
      // before the sources fetch, so a source that can't authenticate on a
      // fresh build still gets its variable named.
      beforeSources: (config) => {
        reportDiagnostics(checkRequiredSecrets(config), options.root);
      },
      devServerUrl: options.devServerUrl,
      mode: options.mode,
      overrides: options.overrides,
      preview: options.preview,
      refresh: options.refresh,
      runtimeDir: options.runtimeDir,
    });
  } catch (error) {
    if (error instanceof BlumeError) {
      reportDiagnostics([error.diagnostic], options.root);
    } else {
      reportInternalError(error);
    }
    process.exit(1);
  }

  // Hard gate: server-only features cannot ship in a static build.
  if (
    options.mode === "build" &&
    project.config.deployment.options.output === "static"
  ) {
    const features = serverFeatures(project.config);
    if (features.length > 0) {
      // A host adapter already names the target, so only its
      // `output: "static"` stands in the way; otherwise name one.
      const { kind } = project.config.deployment;
      reportDiagnostics(
        [
          {
            code: "BLUME_SERVER_FEATURE_REQUIRED",
            message: `${features.join(", ")} ${features.length === 1 ? "requires" : "require"} server output, but this is a static build.`,
            severity: "error",
            suggestion:
              kind === "static"
                ? 'Set deployment to a host adapter from "blume/deploy" in blume.config.ts, e.g. `deployment: vercel()`.'
                : `Drop \`output: "static"\` from \`deployment: ${kind}()\` in blume.config.ts to build for the server.`,
          },
        ],
        options.root
      );
      process.exit(1);
    }
  }

  const hadErrors = reportDiagnostics(project.diagnostics, options.root);
  const dropped =
    project.droppedPages > 0
      ? `${project.droppedPages} page(s) failed frontmatter validation and were dropped from the site. `
      : "";
  const optIn = options.strictOptIn ?? options.mode === "dev";
  if (hadErrors && options.strict) {
    logger.error(
      `Aborting due to errors. ${dropped}Fix the diagnostics above, or ${optIn ? "drop --strict" : "pass --no-strict"} to continue despite them.`
    );
    process.exit(1);
  }
  if (hasErrors(project.diagnostics) && !options.strict) {
    logger.warn(
      `Continuing despite errors. ${dropped}${optIn ? "Pass --strict" : "Drop --no-strict"} to fail instead.`
    );
  }

  let warnings: string[];
  try {
    ({ warnings } = await generateRuntime(project));
  } catch (error) {
    // A config error the generator raised (an unplannable `components.ts`
    // override, a missing font file) is the user's to fix, not an internal
    // failure: report the diagnostic and stop, like a scan-time error.
    if (error instanceof BlumeError) {
      reportDiagnostics([error.diagnostic], options.root);
      process.exit(1);
    }
    throw error;
  }
  for (const warning of warnings) {
    logger.warn(warning);
  }

  return project;
};
