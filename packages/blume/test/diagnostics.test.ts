import { describe, expect, it } from "bun:test";

import { z } from "zod";

import {
  BlumeError,
  countBySeverity,
  createDiagnostic,
  diagnosticsFromZod,
  formatDiagnostic,
  hasErrors,
} from "../src/core/diagnostics.ts";
import type { Diagnostic } from "../src/core/types.ts";

const ESC = String.fromCodePoint(27);

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  code: "BLUME_TEST",
  message: "Something went wrong",
  severity: "error",
  ...over,
});

describe("BlumeError", () => {
  it("wraps a diagnostic, exposing its message and a stable name", () => {
    const diagnostic = diag();
    const error = new BlumeError(diagnostic);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Something went wrong");
    expect(error.name).toBe("BlumeError");
    expect(error.diagnostic).toBe(diagnostic);
  });
});

describe("createDiagnostic", () => {
  it("returns the diagnostic unchanged (typed identity)", () => {
    const diagnostic = diag();
    expect(createDiagnostic(diagnostic)).toBe(diagnostic);
  });
});

describe("diagnosticsFromZod", () => {
  it("anchors a path-scoped issue with code, file, and received value", () => {
    const result = z.object({ count: z.number() }).safeParse({ count: "x" });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const [diagnostic] = diagnosticsFromZod(result.error, {
      code: "BLUME_X",
      file: "/abs/a.md",
    });
    expect(diagnostic?.code).toBe("BLUME_X");
    expect(diagnostic?.file).toBe("/abs/a.md");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.schemaPath).toBe("count");
    expect(diagnostic?.message).toContain("count: ");
    expect(diagnostic?.message).toContain("received:");
  });

  it("omits the schema path for a top-level issue", () => {
    const result = z.number().safeParse("nope");
    if (result.success) {
      throw new Error("expected a failure");
    }
    const [diagnostic] = diagnosticsFromZod(result.error, { code: "BLUME_Y" });
    expect(diagnostic?.schemaPath).toBeUndefined();
    expect(diagnostic?.message.startsWith(":")).toBe(false);
  });

  it("handles issues that carry no received value", () => {
    const result = z.string().min(5).safeParse("hi");
    if (result.success) {
      throw new Error("expected a failure");
    }
    const [diagnostic] = diagnosticsFromZod(result.error, { code: "BLUME_Z" });
    expect(diagnostic?.message).not.toContain("received:");
  });
});

describe("formatDiagnostic", () => {
  it("renders code, message, location, suggestion, and docs", () => {
    const out = formatDiagnostic(
      diag({
        column: 4,
        docsUrl: "https://blume.dev/errors",
        file: "/root/docs/a.md",
        line: 12,
        suggestion: "Fix the link",
      }),
      "/root"
    );
    expect(out).toContain("BLUME_TEST");
    expect(out).toContain("Something went wrong");
    expect(out).toContain("at docs/a.md:12:4");
    expect(out).toContain("fix: Fix the link");
    expect(out).toContain("docs: https://blume.dev/errors");
  });

  it("uses the absolute file path and omits position when no root or line", () => {
    const out = formatDiagnostic(diag({ file: "/abs/a.md" }));
    expect(out).toContain("at /abs/a.md");
    expect(out).not.toContain("/abs/a.md:");
  });

  it("colors by severity", () => {
    expect(formatDiagnostic(diag({ severity: "error" }))).toContain(
      `${ESC}[31m`
    );
    expect(formatDiagnostic(diag({ severity: "warning" }))).toContain(
      `${ESC}[33m`
    );
    expect(formatDiagnostic(diag({ severity: "info" }))).toContain(
      `${ESC}[34m`
    );
  });
});

describe("hasErrors / countBySeverity", () => {
  const list: Diagnostic[] = [
    diag({ severity: "warning" }),
    diag({ severity: "info" }),
    diag({ severity: "error" }),
    diag({ severity: "error" }),
  ];

  it("detects whether any diagnostic is an error", () => {
    expect(hasErrors(list)).toBe(true);
    expect(hasErrors([diag({ severity: "warning" })])).toBe(false);
    expect(hasErrors([])).toBe(false);
  });

  it("tallies counts per severity", () => {
    expect(countBySeverity(list)).toStrictEqual({
      error: 2,
      info: 1,
      warning: 1,
    });
  });
});
