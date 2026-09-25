import { describe, expect, it } from "bun:test";

import { duration, money, seconds } from "../src/cli/report-format.ts";

describe("duration", () => {
  it("prints tenths of a second under a minute", () => {
    expect(duration(0)).toBe("0.0s");
    expect(duration(1500)).toBe("1.5s");
    expect(duration(59_940)).toBe("59.9s");
  });

  it("prints minutes and whole seconds from a minute up", () => {
    expect(duration(60_000)).toBe("1m 0s");
    expect(duration(252_000)).toBe("4m 12s");
  });

  it("rounds before splitting, so a boundary carries over", () => {
    // Rounding the remainder after taking the minutes printed "1m 60s", and
    // rounding tenths after the under-a-minute test printed "60.0s".
    expect(duration(59_990)).toBe("1m 0s");
    expect(duration(119_700)).toBe("2m 0s");
    expect(duration(3_599_600)).toBe("60m 0s");
  });
});

describe("seconds and money", () => {
  it("format a duration and an optional cost", () => {
    expect(seconds(1234)).toBe("1.2s");
    expect(money(1.234)).toBe("$1.23");
  });
});
