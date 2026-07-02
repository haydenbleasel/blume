import { consola } from "consola";

import {
  countBySeverity,
  enrichDiagnostic,
  formatDiagnostic,
  hasErrors,
} from "../core/diagnostics.ts";
import type { Diagnostic } from "../core/types.ts";

export const logger = consola.withTag("blume");

/** Print a batch of diagnostics and return whether any were errors. */
export const reportDiagnostics = (
  diagnostics: Diagnostic[],
  root?: string
): boolean => {
  if (diagnostics.length === 0) {
    return false;
  }

  for (const diagnostic of diagnostics) {
    process.stderr.write(
      `${formatDiagnostic(enrichDiagnostic(diagnostic), root)}\n`
    );
  }

  const counts = countBySeverity(diagnostics);
  const summary = [
    counts.error ? `${counts.error} error(s)` : null,
    counts.warning ? `${counts.warning} warning(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (summary) {
    process.stderr.write(`\n${summary}\n`);
  }

  return hasErrors(diagnostics);
};
