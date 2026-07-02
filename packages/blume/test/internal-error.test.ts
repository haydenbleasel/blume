import { describe, expect, it, spyOn } from "bun:test";

import { reportInternalError } from "../src/cli/internal-error.ts";

const capture = (run: () => void): string => {
  let out = "";
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return out;
};

describe("reportInternalError", () => {
  it("prints a stable code, the message, and an environment dump", () => {
    const out = capture(() => reportInternalError(new Error("boom")));
    expect(out).toContain("BLUME_INTERNAL");
    expect(out).toContain("boom");
    expect(out).toContain("Node:");
    expect(out).toContain("Platform:");
    expect(out).toContain("github.com/haydenbleasel/blume/issues");
  });

  it("handles a non-Error value", () => {
    const out = capture(() => reportInternalError("just a string"));
    expect(out).toContain("BLUME_INTERNAL");
    expect(out).toContain("just a string");
  });
});
