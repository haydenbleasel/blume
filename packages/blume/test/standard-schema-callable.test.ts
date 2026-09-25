import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";
import { isStandardSchema } from "../src/core/standard-schema.ts";
import type { StandardSchema } from "../src/core/standard-schema.ts";

/**
 * An ArkType-shaped schema: a callable function carrying the `~standard`
 * contract, the way every ArkType `type(...)` is.
 */
const callableSchema = (): StandardSchema<string> =>
  Object.assign((value: string) => value, {
    "~standard": {
      validate: (value: string) =>
        value === "core"
          ? { value }
          : { issues: [{ message: "must be core", path: [] }] },
      vendor: "arktype",
      version: 1 as const,
    },
  });

describe("callable Standard Schemas", () => {
  it("recognizes a function that carries ~standard", () => {
    expect(isStandardSchema(callableSchema())).toBe(true);
  });

  it("rejects values without a ~standard validate", () => {
    for (const value of [null, undefined, "schema", 1, {}, () => 1]) {
      expect(isStandardSchema(value)).toBe(false);
    }
    expect(isStandardSchema({ "~standard": {} })).toBe(false);
  });

  it("accepts one in frontmatter.extend and validates pages with it", () => {
    const team = callableSchema();
    const config = blumeConfigSchema.parse({
      frontmatter: { extend: { team } },
    });
    const ctx = {
      defaultType: "doc",
      frontmatterExtend: config.frontmatter.extend,
      source: { name: "s", staged: false },
    };
    const ok = normalizeEntry(
      { body: { format: "md", text: "" }, data: { team: "core" }, ref: "a.md" },
      ctx
    );
    expect(ok.pages[0]?.custom).toStrictEqual({ team: "core" });
    const bad = normalizeEntry(
      { body: { format: "md", text: "" }, data: { team: "web" }, ref: "b.md" },
      ctx
    );
    expect(bad.diagnostics[0]?.message).toBe("team: must be core");
  });
});
