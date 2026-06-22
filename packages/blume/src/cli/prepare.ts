import { generateRuntime } from "../astro/generate.ts";
import { BlumeError, hasErrors } from "../core/diagnostics.ts";
import { scanProject } from "../core/project-graph.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { logger, reportDiagnostics } from "./log.ts";

export interface PrepareOptions {
  root: string;
  strict?: boolean;
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
    project = await scanProject(options.root);
  } catch (error) {
    if (error instanceof BlumeError) {
      reportDiagnostics([error.diagnostic], options.root);
      process.exit(1);
    }
    throw error;
  }

  const hadErrors = reportDiagnostics(project.diagnostics, options.root);
  if (hadErrors && options.strict) {
    logger.error("Aborting due to errors (strict mode).");
    process.exit(1);
  }
  if (hasErrors(project.diagnostics) && !options.strict) {
    logger.warn("Continuing despite errors. Use --strict to fail the build.");
  }

  await generateRuntime(project);
  return project;
};
