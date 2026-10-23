import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import {
  flushStdout,
  reportDiagnostics,
  reportDiagnosticsUnlessRepeated,
  reportDiagnosticsJson,
} from "../src/cli/log.ts";
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
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    output += String(chunk);
    return true;
  };
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

describe("reportDiagnosticsUnlessRepeated", () => {
  it("stays quiet when the batch repeats the one already printed", () => {
    // `blume dev` prints the startup batch, then regenerates once when Vite
    // bumps the port; that unchanged batch must not print a second time.
    expect(
      reportDiagnosticsUnlessRepeated([{ ...warning }], "/root", [warning])
    ).toBe(false);
    expect(output).toBe("");
  });

  it("stays quiet when the repeat lists the same diagnostics in another order", () => {
    // A rescan collects include errors as their file reads finish, so the
    // same batch can come back reordered. It still reports its errors.
    expect(
      reportDiagnosticsUnlessRepeated([error, warning], "/root", [
        warning,
        error,
      ])
    ).toBe(true);
    expect(output).toBe("");
  });

  it("prints a batch that differs from the one already printed", () => {
    expect(
      reportDiagnosticsUnlessRepeated([warning, error], "/root", [warning])
    ).toBe(true);
    expect(output).toContain("1 error(s), 1 warning(s)");

    output = "";
    const located = { ...warning, file: "/root/docs/a.md", line: 2 };
    reportDiagnosticsUnlessRepeated([{ ...located, line: 3 }], "/root", [
      located,
    ]);
    expect(output).toContain("a warning");
  });

  it("prints a batch whose url, suggestion, or docs link changed", () => {
    // These lines are part of what the terminal shows, so a change to any of
    // them alone is a new report, not a repeat.
    const printed = { ...warning, suggestion: "old fix" };
    for (const changed of [
      { ...printed, suggestion: "new fix" },
      { ...printed, url: "/docs/page" },
      { ...printed, docsUrl: "https://example.com/docs" },
    ]) {
      output = "";
      reportDiagnosticsUnlessRepeated([changed], "/root", [printed]);
      expect(output).toContain("a warning");
    }
  });

  it("prints a batch where only a severity changed", () => {
    // Without colors the printed lines don't name the severity, so the key
    // has to: a warning that became an error is a new report.
    reportDiagnosticsUnlessRepeated(
      [{ ...warning, severity: "error" }],
      "/root",
      [warning]
    );
    expect(output).toContain("1 error(s)");
  });

  it("always prints when nothing was printed before", () => {
    reportDiagnosticsUnlessRepeated([warning], "/root");
    expect(output).toContain("a warning");
  });
});

const captureStdout = (run: () => boolean) => {
  let out = "";
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  let result: boolean;
  try {
    result = run();
  } finally {
    spy.mockRestore();
  }
  return { out, result };
};

describe("reportDiagnosticsJson", () => {
  const secret: Diagnostic = {
    code: "BLUME_MISSING_SECRET",
    file: "/root/apps/docs/blume.config.ts",
    message: "needs a secret",
    severity: "error",
  };

  it("emits enriched diagnostics with a root-relative file and reports errors", () => {
    const { out, result } = captureStdout(() =>
      reportDiagnosticsJson([secret, warning], "/root")
    );
    expect(result).toBe(true);
    // SAFETY: `out` is the JSON payload reportDiagnosticsJson just printed,
    // which always carries `diagnostics` and `summary`.
    const payload = JSON.parse(out) as {
      diagnostics: Diagnostic[];
      summary: Record<string, number>;
    };
    // enrichDiagnostic fills docsUrl from the code map.
    expect(payload.diagnostics[0]?.docsUrl).toBe(
      "https://useblume.dev/docs/deployment"
    );
    // The absolute file is made relative to root.
    expect(payload.diagnostics[0]?.file).toBe("apps/docs/blume.config.ts");
    expect(payload.summary).toEqual({ error: 1, info: 0, warning: 1 });
  });

  it("leaves the file absolute when no root is given and reports no errors", () => {
    const { out, result } = captureStdout(() =>
      reportDiagnosticsJson([{ ...secret, severity: "warning" }])
    );
    expect(result).toBe(false);
    // SAFETY: `out` is the JSON payload reportDiagnosticsJson just printed,
    // which always carries `diagnostics`.
    const payload = JSON.parse(out) as { diagnostics: Diagnostic[] };
    expect(payload.diagnostics[0]?.file).toBe(
      "/root/apps/docs/blume.config.ts"
    );
  });
});

describe("flushStdout", () => {
  it("resolves once stdout has drained", async () => {
    // Used before a non-zero exit so a piped `--json` payload isn't truncated.
    await expect(flushStdout()).resolves.toBeUndefined();
  });
});
