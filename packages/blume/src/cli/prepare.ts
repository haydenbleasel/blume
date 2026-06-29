import { generateRuntime } from "../astro/generate.ts";
import { BlumeError, hasErrors } from "../core/diagnostics.ts";
import { scanProject } from "../core/project-graph.ts";
import type { BlumeProject, BuildMode } from "../core/project-graph.ts";
import { serverFeatures } from "../core/server-features.ts";
import { logger, reportDiagnostics } from "./log.ts";

export interface PrepareOptions {
  root: string;
  mode?: BuildMode;
  strict?: boolean;
  /** Local dev server URL, used as the `deployment.site` fallback (dev only). */
  devServerUrl?: string;
  /** Render drafts and fetch unpublished CMS content. */
  preview?: boolean;
  /** Force remote sources to re-fetch instead of serving the cached snapshot. */
  refresh?: boolean;
}

/**
 * Scan the project, surface diagnostics, and (re)generate the `.blume` runtime.
 * In strict mode, any error aborts. Returns the resolved project.
 */
export const prepareProject = async (
  options: PrepareOptions
): Promise<BlumeProject> => {
  let project: BlumeProject;
  try {
    project = await scanProject(options.root, {
      devServerUrl: options.devServerUrl,
      mode: options.mode,
      preview: options.preview,
      refresh: options.refresh,
    });
  } catch (error) {
    if (error instanceof BlumeError) {
      reportDiagnostics([error.diagnostic], options.root);
      process.exit(1);
    }
    throw error;
  }

  // Hard gate: server-only features cannot ship in a static build.
  if (
    options.mode === "build" &&
    project.config.deployment.output === "static"
  ) {
    const features = serverFeatures(project.config);
    if (features.length > 0) {
      reportDiagnostics(
        [
          {
            code: "BLUME_SERVER_FEATURE_REQUIRED",
            message: `${features.join(", ")} require server output, but deployment.output is "static".`,
            severity: "error",
            suggestion:
              'Set deployment: { output: "server", adapter: "vercel" } in blume.config.ts.',
          },
        ],
        options.root
      );
      process.exit(1);
    }
  }

  const hadErrors = reportDiagnostics(project.diagnostics, options.root);
  if (hadErrors && options.strict) {
    logger.error("Aborting due to errors (strict mode).");
    process.exit(1);
  }
  if (hasErrors(project.diagnostics) && !options.strict) {
    logger.warn("Continuing despite errors. Use --strict to fail the build.");
  }

  const { warnings } = await generateRuntime(project);
  for (const warning of warnings) {
    logger.warn(warning);
  }
  return project;
};
