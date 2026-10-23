import { consola } from "consola";
import { relative } from "pathe";

import {
  countBySeverity,
  enrichDiagnostic,
  formatDiagnostic,
  hasErrors,
} from "../core/diagnostics.ts";
import type { Diagnostic } from "../core/types.ts";

export const logger = consola.withTag("blume");

/**
 * Resolve once stdout has drained. `process.exit` doesn't flush a piped stdout,
 * so await this before exiting non-zero after writing machine-readable output
 * (e.g. `--json`), otherwise the payload can be truncated in CI.
 */
export const flushStdout = (): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- adapt stdout's write callback
  new Promise((resolve) => {
    process.stdout.write("", () => resolve());
  });

/**
 * Print diagnostics as a JSON document on stdout for CI and editors: each is
 * enriched with its `docsUrl` and its `file` made root-relative. Returns whether
 * any were errors, matching {@link reportDiagnostics}.
 */
export const reportDiagnosticsJson = (
  diagnostics: Diagnostic[],
  root?: string
): boolean => {
  const enriched = diagnostics.map((diagnostic) => {
    const withDocs = enrichDiagnostic(diagnostic);
    return withDocs.file && root
      ? { ...withDocs, file: relative(root, withDocs.file) }
      : withDocs;
  });
  process.stdout.write(
    `${JSON.stringify(
      { diagnostics: enriched, summary: countBySeverity(diagnostics) },
      null,
      2
    )}\n`
  );
  return hasErrors(diagnostics);
};

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

/**
 * What makes two diagnostics the same report: their severity and exactly the
 * lines {@link reportDiagnostics} prints for them, enrichment included.
 */
const diagnosticKey = (diagnostic: Diagnostic, root: string): string =>
  `${diagnostic.severity}\u0000${formatDiagnostic(enrichDiagnostic(diagnostic), root)}`;

/**
 * {@link reportDiagnostics}, but silent when `diagnostics` repeats the batch
 * `printed` already showed. Without `printed` it always reports.
 */
export const reportDiagnosticsUnlessRepeated = (
  diagnostics: Diagnostic[],
  root: string,
  printed?: Diagnostic[]
): void => {
  if (
    printed &&
    JSON.stringify(printed.map((d) => diagnosticKey(d, root))) ===
      JSON.stringify(diagnostics.map((d) => diagnosticKey(d, root)))
  ) {
    return;
  }
  reportDiagnostics(diagnostics, root);
};
