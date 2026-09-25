import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";

describe("dateFormat.timeZone", () => {
  it("accepts a time zone Intl knows", () => {
    for (const timeZone of ["UTC", "Asia/Tokyo", "America/New_York"]) {
      expect(
        blumeConfigSchema.parse({ dateFormat: { timeZone } }).dateFormat
      ).toMatchObject({ timeZone });
    }
  });

  it("rejects an unknown one at the key, before any page renders", () => {
    const result = blumeConfigSchema.safeParse({
      dateFormat: { timeZone: "Asia/Tokio" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      message:
        'Unknown time zone; use an IANA name like "Asia/Tokyo" or "UTC".',
      path: ["dateFormat", "timeZone"],
    });
  });
});
