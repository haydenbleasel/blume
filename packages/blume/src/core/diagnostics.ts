import { relative } from "pathe";
import type { ZodError } from "zod";

import type { Diagnostic } from "./types.ts";

/** A recoverable error carrying a structured diagnostic. */
export class BlumeError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "BlumeError";
    this.diagnostic = diagnostic;
  }
}

export const createDiagnostic = (diagnostic: Diagnostic): Diagnostic =>
  diagnostic;

/** Convert a ZodError into Blume diagnostics, anchored to a file. */
export const diagnosticsFromZod = (
  error: ZodError,
  options: { code: string; file?: string }
): Diagnostic[] =>
  error.issues.map((issue) => {
    const schemaPath = issue.path.join(".");
    const received =
      "received" in issue
        ? ` (received: ${JSON.stringify(issue.received)})`
        : "";
    return {
      code: options.code,
      file: options.file,
      message: schemaPath
        ? `${schemaPath}: ${issue.message}${received}`
        : `${issue.message}${received}`,
      schemaPath: schemaPath || undefined,
      severity: "error",
    } satisfies Diagnostic;
  });

const ESC = String.fromCodePoint(27);
const COLORS = {
  blue: `${ESC}[34m`,
  bold: `${ESC}[1m`,
  cyan: `${ESC}[36m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  reset: `${ESC}[0m`,
  yellow: `${ESC}[33m`,
};

const severityColor = (severity: Diagnostic["severity"]): string => {
  if (severity === "error") {
    return COLORS.red;
  }
  if (severity === "warning") {
    return COLORS.yellow;
  }
  return COLORS.blue;
};

/** Format a single diagnostic for terminal output. */
export const formatDiagnostic = (
  diagnostic: Diagnostic,
  root?: string
): string => {
  const color = severityColor(diagnostic.severity);
  const lines: string[] = [
    `${color}${COLORS.bold}${diagnostic.code}${COLORS.reset} ${diagnostic.message}`,
  ];

  if (diagnostic.file) {
    const location = root ? relative(root, diagnostic.file) : diagnostic.file;
    const column =
      diagnostic.column === undefined ? "" : `:${diagnostic.column}`;
    const position =
      diagnostic.line === undefined ? "" : `:${diagnostic.line}${column}`;
    lines.push(`  ${COLORS.dim}at ${location}${position}${COLORS.reset}`);
  }

  if (diagnostic.suggestion) {
    lines.push(`  ${COLORS.cyan}fix: ${diagnostic.suggestion}${COLORS.reset}`);
  }

  if (diagnostic.docsUrl) {
    lines.push(`  ${COLORS.dim}docs: ${diagnostic.docsUrl}${COLORS.reset}`);
  }

  return lines.join("\n");
};

export const hasErrors = (diagnostics: Diagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error");

export const countBySeverity = (
  diagnostics: Diagnostic[]
): Record<Diagnostic["severity"], number> => {
  const counts = { error: 0, info: 0, warning: 0 };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  return counts;
};
