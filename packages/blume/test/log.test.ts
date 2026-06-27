import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { reportDiagnostics } from "../src/cli/log.ts";
import type { Diagnostic } from "../src/core/types.ts";

const warning: Diagnostic = {
  code: "BLUME_W",
  message: "a warning",
  severity: "warning",
};
const error: Diagnostic = {
  code: "BLUME_E",
  message: "an error",
  severity: "error",
};

let output = "";
const originalWrite = process.stderr.write;

beforeEach(() => {
  output = "";
  process.stderr.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as unknown as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
});

describe("reportDiagnostics", () => {
  it("writes nothing and returns false for an empty list", () => {
    expect(reportDiagnostics([])).toBe(false);
    expect(output).toBe("");
  });

  it("prints warnings with a summary and reports no errors", () => {
    const hadErrors = reportDiagnostics([warning]);
    expect(hadErrors).toBe(false);
    expect(output).toContain("a warning");
    expect(output).toContain("1 warning(s)");
  });

  it("reports errors and includes them in the summary", () => {
    const hadErrors = reportDiagnostics([error, warning]);
    expect(hadErrors).toBe(true);
    expect(output).toContain("1 error(s), 1 warning(s)");
  });
});
