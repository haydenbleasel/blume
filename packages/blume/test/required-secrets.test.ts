import { afterEach, describe, expect, it } from "bun:test";

import { checkRequiredSecrets } from "../src/cli/required-secrets.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

const KEYS = ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY", "MIXEDBREAD_API_KEY"];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});

describe("checkRequiredSecrets", () => {
  it("has nothing to require for a default config", () => {
    expect(checkRequiredSecrets(blumeConfigSchema.parse({}))).toEqual([]);
  });

  it("warns when Ask AI (gateway) has no AI_GATEWAY_API_KEY", () => {
    Reflect.deleteProperty(process.env, "AI_GATEWAY_API_KEY");
    const config = blumeConfigSchema.parse({ ai: { ask: { enabled: true } } });
    const result = checkRequiredSecrets(config);
    expect(result[0]?.code).toBe("BLUME_MISSING_SECRET");
    expect(result[0]?.message).toContain("AI_GATEWAY_API_KEY");
  });

  it("is satisfied when the key is set", () => {
    process.env.AI_GATEWAY_API_KEY = "sk-test";
    const config = blumeConfigSchema.parse({ ai: { ask: { enabled: true } } });
    expect(checkRequiredSecrets(config)).toEqual([]);
  });

  it("warns when a non-gateway Ask AI backend has no API key", () => {
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    const config = blumeConfigSchema.parse({
      ai: { ask: { enabled: true, provider: "openrouter" } },
    });
    expect(
      checkRequiredSecrets(config).some(
        (d) =>
          d.code === "BLUME_MISSING_SECRET" &&
          d.message.includes("OPENROUTER_API_KEY")
      )
    ).toBe(true);
  });

  it("warns for mixedbread search without its key", () => {
    Reflect.deleteProperty(process.env, "MIXEDBREAD_API_KEY");
    const config = blumeConfigSchema.parse({
      search: { mixedbread: { storeId: "s" }, provider: "mixedbread" },
    });
    expect(
      checkRequiredSecrets(config).some((d) =>
        d.message.includes("MIXEDBREAD_API_KEY")
      )
    ).toBe(true);
  });
});
