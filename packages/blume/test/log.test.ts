import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import {
  flushStdout,
  reportDiagnostics,
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

const captureStdout = (
  run: () => boolean
): { out: string; result: boolean } => {
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
