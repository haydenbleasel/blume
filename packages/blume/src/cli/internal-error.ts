import { getBlumeVersion } from "../core/version.ts";

const ESC = String.fromCodePoint(27);
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

const ISSUES_URL = "https://github.com/haydenbleasel/blume/issues";

/**
 * Print an unexpected (non-{@link BlumeError}) failure in a stable, reportable
 * shape instead of a bare stack trace: a fixed `BLUME_INTERNAL` code, the
 * message, a trimmed stack, and an environment dump for bug reports. Callers
 * exit after this — it doesn't exit itself, so it's testable.
 */
export const reportInternalError = (error: unknown): void => {
  const err = error instanceof Error ? error : new Error(String(error));
  const lines = [
    `${RED}${BOLD}BLUME_INTERNAL${RESET} An unexpected error occurred.`,
    `  ${err.message}`,
  ];

  // A few frames are enough to locate the fault without burying the report.
  const stack = (err.stack ?? "")
    .split("\n")
    .slice(1, 5)
    .map((line) => line.trim())
    .filter(Boolean);
  if (stack.length > 0) {
    lines.push("", `${DIM}${stack.join("\n")}${RESET}`);
  }

  lines.push(
    "",
    "This is likely a bug in Blume. Please report it with the details below:",
    `  ${DIM}Blume:    ${getBlumeVersion()}`,
    `  Node:     ${process.version}`,
    `  Platform: ${process.platform} ${process.arch}${RESET}`,
    `  ${ISSUES_URL}`
  );

  process.stderr.write(`${lines.join("\n")}\n`);
};
