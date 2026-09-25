import { describe, expect, it, spyOn } from "bun:test";

import { MAX_TIMEOUT_S, parseTimeoutSeconds } from "../src/cli/args.ts";
import { logger } from "../src/cli/log.ts";

describe("parseTimeoutSeconds", () => {
  it("returns the fallback when no timeout is given", () => {
    expect(parseTimeoutSeconds(undefined, 180)).toBe(180);
  });

  it("parses whole seconds up to what a timer can hold", () => {
    expect(parseTimeoutSeconds("1", 180)).toBe(1);
    expect(parseTimeoutSeconds(String(MAX_TIMEOUT_S), 180)).toBe(MAX_TIMEOUT_S);
    // The ceiling is the largest delay setTimeout honors, in milliseconds.
    expect(MAX_TIMEOUT_S * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
    expect((MAX_TIMEOUT_S + 1) * 1000).toBeGreaterThan(2 ** 31 - 1);
  });

  it("logs an error and exits for an invalid or too-long timeout", () => {
    const messages: string[] = [];
    const record = (message: string): void => {
      messages.push(message);
    };
    // SAFETY: parseTimeoutSeconds only calls the logger as a function; the
    // `raw` member consola's LogFn declares is never touched.
    const errorSpy = spyOn(logger, "error").mockImplementation(record as never);
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      for (const invalid of ["", "abc", "0", "-5", "1.5"]) {
        expect(() => parseTimeoutSeconds(invalid, 180)).toThrow("exit");
      }
      expect(messages.at(-1)).toBe('Invalid --timeout "1.5" (whole seconds).');
      // Node clamps a longer setTimeout delay to 1 ms, which would time every
      // agent out at once.
      expect(() => parseTimeoutSeconds(String(MAX_TIMEOUT_S + 1), 180)).toThrow(
        "exit"
      );
      expect(messages.at(-1)).toContain(
        `(at most ${MAX_TIMEOUT_S} seconds, about 24 days)`
      );
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
