import { z } from "zod";

import {
  GATEWAY_API_KEY_ENV,
  OPENAI_API_KEY_ENV,
  sharedOptions,
} from "../ai/ask.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";

/** The speech model narration uses when `gateway()` names none. */
export const DEFAULT_NARRATION_MODEL = "openai/tts-1-hd";

/** The voice narration uses when the provider names none. */
export const DEFAULT_NARRATION_VOICE = "alloy";

/**
 * The AI SDK provider `openai()` narration speaks through, with or without a
 * `baseUrl`: `@ai-sdk/openai-compatible` has no speech models.
 */
export const OPENAI_SPEECH_DEP = "@ai-sdk/openai";

/**
 * Whether `url` carries a username or password, which `fetch` refuses to
 * send and whose error message would print them. A URL that doesn't parse
 * has none.
 */
export const hasCredentials = (url: string): boolean => {
  const parsed = URL.parse(url);
  return Boolean(parsed?.username || parsed?.password);
};

/** The narration options both providers take on top of the shared ones. */
const speechOptions = {
  instructions: z.string().min(1).optional(),
  voice: z.string().min(1).default(DEFAULT_NARRATION_VOICE),
};

const gatewayNarrationSchema = adapterDescriptorSchema(
  "gateway",
  z.strictObject({
    ...sharedOptions(GATEWAY_API_KEY_ENV),
    ...speechOptions,
    model: z.string().min(1).default(DEFAULT_NARRATION_MODEL),
  })
);

const openaiNarrationSchema = adapterDescriptorSchema(
  "openai",
  z.strictObject({
    ...sharedOptions(OPENAI_API_KEY_ENV),
    ...speechOptions,
    // Replaces the shared default: whether it's OPENAI_API_KEY depends on
    // the `baseUrl` (see below).
    apiKeyEnv: z.string().min(1).optional(),
    // An unparsable URL is left to `z.url()`.
    baseUrl: z
      .url()
      .refine((url) => !hasCredentials(url), {
        message:
          "Credentials don't go in the baseUrl: name the env var holding the key in apiKeyEnv.",
      })
      .optional(),
    model: z.string().min(1),
  })
);

/**
 * `narration.provider`: the `gateway()` or `openai()` descriptor from
 * `blume/ai`, read with speech defaults. `reasoning` (and `openai()`'s
 * `name`, which speech models don't read) are assistant options and are
 * rejected here; `voice` and `instructions` are narration options and are
 * rejected by the assistant.
 *
 * `openai()` is read for what narration needs, not what the assistant does:
 * it speaks through `@ai-sdk/openai` whatever the `baseUrl`, and a custom
 * endpoint gets only the key `apiKeyEnv` names, never `OPENAI_API_KEY` by
 * default, so it may take none at all. A key that is named is required.
 */
export const narrationProviderSchema = z
  .discriminatedUnion("kind", [gatewayNarrationSchema, openaiNarrationSchema])
  .transform((provider) => {
    if (provider.kind !== "openai") {
      return provider;
    }
    const { options } = provider;
    const apiKeyEnv =
      options.apiKeyEnv ?? (options.baseUrl ? undefined : OPENAI_API_KEY_ENV);
    return {
      ...provider,
      options: apiKeyEnv ? { ...options, apiKeyEnv } : options,
      requiredSecrets: apiKeyEnv ? [apiKeyEnv] : [],
      runtimeDeps: [OPENAI_SPEECH_DEP],
    };
  });

/** A validated narration provider, defaults filled in. */
export type NarrationProvider = z.output<typeof narrationProviderSchema>;

/** A validated `gateway()` narration provider. */
export type GatewayNarrationProvider = Extract<
  NarrationProvider,
  { kind: "gateway" }
>;

/** A validated `openai()` narration provider. */
export type OpenAINarrationProvider = Extract<
  NarrationProvider,
  { kind: "openai" }
>;
