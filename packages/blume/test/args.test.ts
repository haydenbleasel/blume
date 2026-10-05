import { describe, expect, it, spyOn } from "bun:test";

import { parseIgnoreFlag, parsePort, repeatedFlag } from "../src/cli/args.ts";
import { logger } from "../src/cli/log.ts";

describe("repeatedFlag", () => {
  it("collects every value in order, in both spellings", () => {
    expect(
      repeatedFlag(
        [
          "--ignore",
          "a",
          "--strict",
          "--ignore=b",
          "--external",
          "--ignore",
          "c",
        ],
        "ignore"
      )
    ).toEqual(["a", "b", "c"]);
  });

  it("reads the next token whatever it looks like, as citty does", () => {
    expect(repeatedFlag(["--ignore", "--strict"], "ignore")).toEqual([
      "--strict",
    ]);
    expect(repeatedFlag(["--strict", "--ignore"], "ignore")).toEqual([""]);
  });

  it("stops at a bare -- and skips other flags that share a prefix", () => {
    expect(
      repeatedFlag(
        ["--ignored", "x", "--ignore", "a", "--", "--ignore", "b"],
        "ignore"
      )
    ).toEqual(["a"]);
    expect(repeatedFlag([], "ignore")).toEqual([]);
  });
});

describe("parseIgnoreFlag", () => {
  it("skips a URL any glob matches, dot segments included", () => {
    const ignored = parseIgnoreFlag([
      "--ignore",
      "https://api.acme.example/**",
      "--ignore=http://localhost:*/**",
    ]);
    expect(ignored("https://api.acme.example/v1/messages")).toBe(true);
    expect(ignored("https://api.acme.example/.well-known/x")).toBe(true);
    expect(ignored("http://localhost:3000/admin")).toBe(true);
    expect(ignored("https://docs.acme.example/")).toBe(false);
  });

  it("skips nothing without an --ignore", () => {
    expect(parseIgnoreFlag(["--external"])("https://example.com/")).toBe(false);
  });

  it("logs an error and exits for an empty glob", () => {
    // SAFETY: parseIgnoreFlag only calls the logger as a function; the `raw`
    // member consola's LogFn declares is never touched.
    const errorSpy = spyOn(logger, "error").mockImplementation((() => {
      // Swallow the diagnostic so the test output stays clean.
    }) as never);
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      expect(() => parseIgnoreFlag(["--ignore"])).toThrow("exit");
      expect(() => parseIgnoreFlag(["--ignore="])).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid --ignore ""')
      );
    } finally {
      exit.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

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
    // SAFETY: parsePort only calls the logger as a function; the `raw` member
    // consola's LogFn declares is never touched, so a bare no-op suffices.
    const errorSpy = spyOn(logger, "error").mockImplementation((() => {
      // Swallow the diagnostic so the test output stays clean.
    }) as never);
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
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
