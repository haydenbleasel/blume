import { describe, expect, it, spyOn } from "bun:test";

import { parsePort } from "../src/cli/args.ts";
import { logger } from "../src/cli/log.ts";

describe("parsePort", () => {
  it("returns undefined when no port is given", () => {
    expect(parsePort()).toBeUndefined();
  });

  it("parses a valid integer port", () => {
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65_535);
  });

  it("logs an error and exits for a non-integer or out-of-range port", () => {
    const errorSpy = spyOn(logger, "error").mockImplementation((() => {
      // Swallow the diagnostic so the test output stays clean.
    }) as never);
    const exit = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      for (const invalid of ["abc", "0", "99999"]) {
        expect(() => parsePort(invalid)).toThrow("exit");
      }
      expect(exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
