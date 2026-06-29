import { describe, expect, it } from "bun:test";

import { defineComponents } from "../src/core/define-components.ts";
import type { ComponentOverrides } from "../src/core/define-components.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { serverFeatures } from "../src/core/server-features.ts";

describe("serverFeatures", () => {
  it("is empty for a default (fully static) config", () => {
    expect(serverFeatures(blumeConfigSchema.parse({}))).toStrictEqual([]);
  });

  it("lists Ask AI when it is enabled", () => {
    const config = blumeConfigSchema.parse({ ai: { ask: { enabled: true } } });
    expect(serverFeatures(config)).toStrictEqual(["Ask AI"]);
  });

  it("ignores Ask AI when present but disabled", () => {
    const config = blumeConfigSchema.parse({ ai: { ask: { enabled: false } } });
    expect(serverFeatures(config)).toStrictEqual([]);
  });
});

describe("defineComponents", () => {
  it("returns the overrides unchanged (identity helper)", () => {
    const overrides: ComponentOverrides = {
      layout: { Header: "./Header.astro" },
      mdx: { Callout: "./Callout.astro" },
    };
    expect(defineComponents(overrides)).toBe(overrides);
  });
});
