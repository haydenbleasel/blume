import { describe, expect, it, spyOn } from "bun:test";

import {
  remapBlumeStack,
  reportInternalError,
} from "../src/cli/internal-error.ts";

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

describe("remapBlumeStack", () => {
  it("relativizes and tags a .blume frame", () => {
    const stack =
      "at render (/Users/me/site/.blume/src/pages/[...slug].astro:12:5)";
    const out = remapBlumeStack(stack);
    expect(out).toContain(".blume/src/pages/[...slug].astro:12:5 (generated)");
    expect(out).not.toContain("/Users/me/site/.blume");
  });

  it("relativizes and tags a Windows drive-letter .blume frame", () => {
    const stack =
      "at render (C:\\Users\\me\\site\\.blume\\src\\pages\\[...slug].astro:12:5)";
    const out = remapBlumeStack(stack);
    expect(out).toContain(
      ".blume\\src\\pages\\[...slug].astro:12:5 (generated)"
    );
    expect(out).not.toContain("C:\\Users\\me\\site\\.blume");
  });

  it("leaves Windows user source frames untouched", () => {
    const stack = "at Foo (C:\\Users\\me\\site\\pages\\index.astro:3:1)";
    expect(remapBlumeStack(stack)).toBe(stack);
  });

  it("leaves user source frames untouched", () => {
    const stack = "at Foo (/Users/me/site/pages/index.astro:3:1)";
    expect(remapBlumeStack(stack)).toBe(stack);
  });
});
