import { afterEach, describe, expect, it } from "bun:test";

import { gateway, openai } from "../src/ai/ask.ts";
import { checkRequiredSecrets } from "../src/cli/required-secrets.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { mixedbread } from "../src/search/adapters/index.ts";

const KEYS = [
  "AI_GATEWAY_API_KEY",
  "LITELLM_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OR_KEY",
  "MIXEDBREAD_API_KEY",
  "PROBE_ANALYTICS_TOKEN",
];
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

  it("warns when the assistant (gateway) has no AI_GATEWAY_API_KEY", () => {
    Reflect.deleteProperty(process.env, "AI_GATEWAY_API_KEY");
    const config = blumeConfigSchema.parse({
      ai: { assistant: { enabled: true } },
    });
    const result = checkRequiredSecrets(config);
    expect(result[0]?.code).toBe("BLUME_MISSING_SECRET");
    expect(result[0]?.message).toBe(
      "Assistant (AI Gateway) is enabled but AI_GATEWAY_API_KEY is not set (on Vercel the gateway can also authenticate via OIDC)."
    );
  });

  it("warns when generated narration has no key to build with", () => {
    Reflect.deleteProperty(process.env, "AI_GATEWAY_API_KEY");
    const config = blumeConfigSchema.parse({
      narration: { provider: gateway() },
    });
    expect(checkRequiredSecrets(config)[0]?.message).toBe(
      "Narration audio is enabled but AI_GATEWAY_API_KEY is not set (read at build; without it pages use browser voices)."
    );
    // Browser voices need no key.
    expect(
      checkRequiredSecrets(blumeConfigSchema.parse({ narration: true }))
    ).toEqual([]);
  });

  it("needs no narration key for an openai() endpoint with a baseUrl", () => {
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    const selfHosted = blumeConfigSchema.parse({
      narration: {
        provider: openai({
          baseUrl: "http://localhost:8880/v1",
          model: "kokoro",
        }),
      },
    });
    expect(checkRequiredSecrets(selfHosted)).toEqual([]);
    const hosted = blumeConfigSchema.parse({
      narration: { provider: openai({ model: "gpt-4o-mini-tts" }) },
    });
    expect(checkRequiredSecrets(hosted)[0]?.message).toBe(
      "Narration audio is enabled but OPENAI_API_KEY is not set (read at build; without it pages use browser voices)."
    );
    // A key named for the endpoint is required.
    Reflect.deleteProperty(process.env, "LITELLM_API_KEY");
    const named = blumeConfigSchema.parse({
      narration: {
        provider: openai({
          apiKeyEnv: "LITELLM_API_KEY",
          baseUrl: "http://litellm.internal/v1",
          model: "tts",
        }),
      },
    });
    expect(checkRequiredSecrets(named)[0]?.message).toBe(
      "Narration audio is enabled but LITELLM_API_KEY is not set (read at build; without it pages use browser voices)."
    );
  });

  it("is satisfied when the key is set", () => {
    process.env.AI_GATEWAY_API_KEY = "sk-test";
    const config = blumeConfigSchema.parse({
      ai: { assistant: { enabled: true } },
    });
    expect(checkRequiredSecrets(config)).toEqual([]);
  });

  it("warns with the adapter's own key env var when it is unset", () => {
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    const config = blumeConfigSchema.parse({
      ai: {
        assistant: {
          enabled: true,
          provider: {
            kind: "openrouter",
            options: { model: "x/y" },
            requiredSecrets: ["OPENROUTER_API_KEY"],
            runtimeDeps: ["@openrouter/ai-sdk-provider"],
          },
        },
      },
    });
    expect(
      checkRequiredSecrets(config).some(
        (d) =>
          d.code === "BLUME_MISSING_SECRET" &&
          d.message ===
            "Assistant (OpenRouter) is enabled but OPENROUTER_API_KEY is not set."
      )
    ).toBe(true);
    // An overridden env var name is what gets checked.
    Reflect.deleteProperty(process.env, "OR_KEY");
    const renamed = blumeConfigSchema.parse({
      ai: {
        assistant: {
          enabled: true,
          provider: {
            kind: "openrouter",
            options: { apiKeyEnv: "OR_KEY", model: "x/y" },
            requiredSecrets: ["OR_KEY"],
            runtimeDeps: ["@openrouter/ai-sdk-provider"],
          },
        },
      },
    });
    expect(checkRequiredSecrets(renamed).map((d) => d.message)).toContainEqual(
      expect.stringContaining("OR_KEY is not set")
    );
  });

  it("checks nothing for an external endpoint", () => {
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    const config = blumeConfigSchema.parse({
      ai: {
        assistant: {
          enabled: true,
          endpoint: "https://api.example.com/ask",
          provider: {
            kind: "openrouter",
            options: { model: "x/y" },
            requiredSecrets: ["OPENROUTER_API_KEY"],
            runtimeDeps: ["@openrouter/ai-sdk-provider"],
          },
        },
      },
    });
    expect(checkRequiredSecrets(config)).toEqual([]);
  });

  it("warns for mixedbread search without its key", () => {
    Reflect.deleteProperty(process.env, "MIXEDBREAD_API_KEY");
    // The adapter declares the secret; the check reads it off the descriptor.
    const config = blumeConfigSchema.parse({
      search: mixedbread({ storeId: "s" }),
    });
    expect(
      checkRequiredSecrets(config).some((d) =>
        d.message.includes("MIXEDBREAD_API_KEY")
      )
    ).toBe(true);
  });

  it("reads an analytics adapter's requiredSecrets from its descriptor", () => {
    Reflect.deleteProperty(process.env, "PROBE_ANALYTICS_TOKEN");
    const config = blumeConfigSchema.parse({
      analytics: [
        {
          kind: "script",
          options: { src: "https://x.test/a.js" },
          requiredSecrets: ["PROBE_ANALYTICS_TOKEN"],
          runtimeDeps: [],
        },
      ],
    });
    const result = checkRequiredSecrets(config);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe(
      "Analytics (script) is enabled but PROBE_ANALYTICS_TOKEN is not set."
    );

    process.env.PROBE_ANALYTICS_TOKEN = "set";
    expect(checkRequiredSecrets(config)).toEqual([]);
  });

  it("warns about the assistant's bot check secret", () => {
    Reflect.deleteProperty(process.env, "TURNSTILE_SECRET_KEY");
    process.env.AI_GATEWAY_API_KEY = "set";
    const config = blumeConfigSchema.parse({
      ai: {
        assistant: {
          captcha: {
            kind: "turnstile",
            options: { siteKey: "0x4" },
            requiredSecrets: ["TURNSTILE_SECRET_KEY"],
            runtimeDeps: [],
          },
          enabled: true,
        },
      },
    });
    expect(checkRequiredSecrets(config).map((d) => d.message)).toStrictEqual([
      "Assistant bot check (turnstile) is enabled but TURNSTILE_SECRET_KEY is not set.",
    ]);
    Reflect.deleteProperty(process.env, "AI_GATEWAY_API_KEY");
  });

  it("reads the consent adapter's requiredSecrets from its descriptor", () => {
    Reflect.deleteProperty(process.env, "PROBE_CONSENT_KEY");
    const config = blumeConfigSchema.parse({
      consent: {
        kind: "native",
        options: {},
        requiredSecrets: ["PROBE_CONSENT_KEY"],
        runtimeDeps: [],
      },
    });
    expect(checkRequiredSecrets(config)[0]?.message).toBe(
      "Consent (native) is enabled but PROBE_CONSENT_KEY is not set."
    );
    process.env.PROBE_CONSENT_KEY = "set";
    expect(checkRequiredSecrets(config)).toEqual([]);
    Reflect.deleteProperty(process.env, "PROBE_CONSENT_KEY");
  });

  it("requires nothing for the built-in analytics adapters", () => {
    const config = blumeConfigSchema.parse({
      analytics: [
        { kind: "vercel", options: {}, requiredSecrets: [], runtimeDeps: [] },
      ],
    });
    expect(checkRequiredSecrets(config)).toEqual([]);
  });
});
