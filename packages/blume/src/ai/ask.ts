import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import { unrecognizedKeysMessage } from "../core/unrecognized-keys.ts";

/**
 * The `reasoning` levels the adapters accept: the AI SDK's top-level
 * `reasoning` values minus `provider-default`, which is what omitting the
 * option means.
 */
export const assistantReasoningLevels = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** How much the model reasons before answering (an adapter's `reasoning`). */
export type AssistantReasoning = (typeof assistantReasoningLevels)[number];

/**
 * The AI SDK's `providerOptions` shape, forwarded to `streamText` verbatim:
 * `{ [provider]: { [option]: value } }`. The escape hatch for model controls
 * Blume doesn't name, so a new provider knob never needs a Blume field.
 */
export type AssistantProviderOptions = Record<
  string,
  Record<string, JsonValue>
>;

/** The AI SDK provider package the OpenAI-compatible adapters install. */
const OPENAI_COMPATIBLE_DEP = "@ai-sdk/openai-compatible";

/**
 * The AI SDK packages for the providers Blume calls directly: the package and
 * the provider factory the route imports from it.
 */
const OPENAI_SDK = { factory: "createOpenAI", pkg: "@ai-sdk/openai" };
const ANTHROPIC_SDK = { factory: "createAnthropic", pkg: "@ai-sdk/anthropic" };
const GEMINI_SDK = { factory: "createGoogle", pkg: "@ai-sdk/google" };
const GROK_SDK = { factory: "createXai", pkg: "@ai-sdk/xai" };

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

/** The options every assistant adapter accepts. */
export interface AssistantAdapterOptions {
  /**
   * Name of the env var holding the provider's API key. Each adapter has its
   * own default; set this only to point at a different variable.
   */
  apiKeyEnv?: string;
  /**
   * Static request headers sent to the provider on every call — a
   * caller-identifying header for a shared backend, for example. Values are
   * written into the generated route as literals, so keep secrets in
   * `apiKeyEnv` rather than here.
   */
  headers?: Record<string, string>;
  /**
   * Options passed to `streamText` as its `providerOptions`, untouched, in the
   * AI SDK's own shape (`{ openai: { textVerbosity: "low" } }`, say).
   */
  providerOptions?: AssistantProviderOptions;
}

/**
 * `providerOptions`, forwarded to `streamText` verbatim. JSON-only, because
 * the generated and ejected routes inline it as a literal.
 */
const providerOptionsSchema = z.record(
  z.string(),
  z.record(z.string(), z.json())
);

/** The shared option schema, with the adapter's own key env var default. */
export const sharedOptions = (apiKeyEnv: string) => ({
  apiKeyEnv: z.string().min(1).default(apiKeyEnv),
  headers: z.record(z.string(), z.string()).optional(),
  providerOptions: providerOptionsSchema.optional(),
});

const reasoningOption = z.enum(assistantReasoningLevels).optional();

// ---------------------------------------------------------------------------
// gateway()
// ---------------------------------------------------------------------------

export const GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY";
/** The model the gateway adapter uses when none is configured. */
const DEFAULT_GATEWAY_MODEL = "openai/gpt-5.5";

/** Options for {@link gateway}. */
export interface AssistantGatewayOptions extends AssistantAdapterOptions {
  /**
   * Narration only: how the voice should sound, for speech models that take
   * instructions ("Read calmly, like a teacher").
   */
  instructions?: string;
  /**
   * A `provider/model` id routed by the gateway. Defaults to `openai/gpt-5.5`
   * for the assistant and `openai/tts-1-hd` for narration.
   */
  model?: string;
  /**
   * How much the model reasons before answering. Sent as the AI SDK's
   * top-level `reasoning` option, which the gateway maps to the model's own
   * control (OpenAI's `reasoning_effort`, for example); the model has to
   * offer the level you pick. Omitted keeps the model's default. Assistant
   * only.
   */
  reasoning?: AssistantReasoning;
  /** Narration only: the speech model's voice. Defaults to `alloy`. */
  voice?: string;
}

const gatewayOptionsSchema = z.strictObject({
  ...sharedOptions(GATEWAY_API_KEY_ENV),
  model: z.string().min(1).default(DEFAULT_GATEWAY_MODEL),
  reasoning: reasoningOption,
});

export type AssistantGatewayAdapter = AdapterDescriptor<
  "gateway",
  AssistantGatewayOptions
>;

export const gatewayAdapterSchema = adapterDescriptorSchema(
  "gateway",
  gatewayOptionsSchema
);

/**
 * Route the assistant through the Vercel AI Gateway (the default), or generate
 * narration audio with one of its speech models. `model` is a
 * `provider/model` string; the key is `AI_GATEWAY_API_KEY`, or Vercel's OIDC
 * token when deployed there. Needs no provider SDK beyond the `ai` package
 * Blume ships.
 */
export const gateway = (
  options: AssistantGatewayOptions = {}
): AssistantGatewayAdapter => ({
  kind: "gateway",
  options,
  requiredSecrets: [options.apiKeyEnv ?? GATEWAY_API_KEY_ENV],
  runtimeDeps: [],
});

// ---------------------------------------------------------------------------
// openai()
// ---------------------------------------------------------------------------

export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/** Options for {@link openai}. */
export interface AssistantOpenAIOptions extends AssistantAdapterOptions {
  /**
   * Name of the env var holding the key. Defaults to `OPENAI_API_KEY`, except
   * for narration with a `baseUrl`, which sends only a key named here.
   */
  apiKeyEnv?: string;
  /**
   * An OpenAI-compatible endpoint to call instead of OpenAI
   * (`https://llm.internal.example.com/v1`): a self-hosted model or an
   * internal gateway. The route then talks Chat Completions through
   * `@ai-sdk/openai-compatible`, and the docs tools are off unless
   * `ai.assistant.tools` turns them on, since the model may not call tools.
   * For narration, a server with OpenAI's speech API (`/audio/speech`),
   * called through `@ai-sdk/openai` and sent only the key `apiKeyEnv` names,
   * if any.
   */
  baseUrl?: string;
  /**
   * Narration only: how the voice should sound, for speech models that take
   * instructions ("Read calmly, like a teacher").
   */
  instructions?: string;
  /** The model id (`gpt-5.5`, or a speech model like `gpt-4o-mini-tts`). */
  model: string;
  /**
   * The provider name the AI SDK reports, which a custom endpoint also reads
   * its `providerOptions` under. Defaults to `openai`, or `openai-compatible`
   * with a `baseUrl`. Assistant only.
   */
  name?: string;
  /**
   * How much the model reasons before answering, sent as `reasoning_effort`;
   * with a `baseUrl`, the endpoint has to accept that parameter. Omitted
   * keeps the model's default. Assistant only.
   */
  reasoning?: AssistantReasoning;
  /** Narration only: the speech model's voice. Defaults to `alloy`. */
  voice?: string;
}

const openaiOptionsSchema = z.strictObject({
  ...sharedOptions(OPENAI_API_KEY_ENV),
  baseUrl: z.url().optional(),
  model: z.string().min(1),
  name: z.string().min(1).optional(),
  reasoning: reasoningOption,
});

export type AssistantOpenAIAdapter = AdapterDescriptor<
  "openai",
  AssistantOpenAIOptions
>;

export const openaiAdapterSchema = adapterDescriptorSchema(
  "openai",
  openaiOptionsSchema
);

/**
 * Route the assistant to OpenAI, or to any OpenAI-compatible endpoint with
 * `baseUrl`. Reads `OPENAI_API_KEY` and needs `@ai-sdk/openai` installed; a
 * custom endpoint needs `@ai-sdk/openai-compatible` instead, since most
 * don't serve OpenAI's Responses API. Narration generates audio with it
 * through `@ai-sdk/openai` either way, and with a `baseUrl` sends only the key
 * `apiKeyEnv` names.
 */
export const openai = (
  options: AssistantOpenAIOptions
): AssistantOpenAIAdapter => ({
  kind: "openai",
  options,
  requiredSecrets: [options.apiKeyEnv ?? OPENAI_API_KEY_ENV],
  runtimeDeps: [options.baseUrl ? OPENAI_COMPATIBLE_DEP : OPENAI_SDK.pkg],
});

/**
 * Options for the deprecated {@link openaiCompatible}: {@link openai}'s, with
 * the endpoint and its key env var required.
 *
 * @deprecated Use {@link AssistantOpenAIOptions}.
 */
export interface AssistantOpenAICompatibleOptions extends AssistantOpenAIOptions {
  apiKeyEnv: string;
  baseUrl: string;
}

/** @deprecated Use {@link AssistantOpenAIAdapter}. */
export type AssistantOpenAICompatibleAdapter = AssistantOpenAIAdapter;

/**
 * Route the assistant through an OpenAI-compatible endpoint.
 *
 * @deprecated Use `openai({ baseUrl, model, apiKeyEnv })`, which this calls.
 */
export const openaiCompatible = (
  options: AssistantOpenAICompatibleOptions
): AssistantOpenAIAdapter => openai(options);

// ---------------------------------------------------------------------------
// anthropic()
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Options for {@link anthropic}. */
export interface AssistantAnthropicOptions extends AssistantAdapterOptions {
  /** The Claude model id (`claude-sonnet-5`). */
  model: string;
  /**
   * How much the model reasons before answering. The Anthropic provider
   * maps the level to the model's thinking: an effort on models with
   * adaptive thinking, a thinking budget on older ones, and thinking off for
   * `"none"`. Omitted keeps the model's default.
   */
  reasoning?: AssistantReasoning;
}

const anthropicOptionsSchema = z.strictObject({
  ...sharedOptions(ANTHROPIC_API_KEY_ENV),
  model: z.string().min(1),
  reasoning: reasoningOption,
});

export type AssistantAnthropicAdapter = AdapterDescriptor<
  "anthropic",
  AssistantAnthropicOptions
>;

export const anthropicAdapterSchema = adapterDescriptorSchema(
  "anthropic",
  anthropicOptionsSchema
);

/**
 * Route the assistant to Anthropic's Claude API. Reads `ANTHROPIC_API_KEY`
 * and needs `@ai-sdk/anthropic` installed.
 */
export const anthropic = (
  options: AssistantAnthropicOptions
): AssistantAnthropicAdapter => ({
  kind: "anthropic",
  options,
  requiredSecrets: [options.apiKeyEnv ?? ANTHROPIC_API_KEY_ENV],
  runtimeDeps: [ANTHROPIC_SDK.pkg],
});

// ---------------------------------------------------------------------------
// gemini()
// ---------------------------------------------------------------------------

const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

/** Options for {@link gemini}. */
export interface AssistantGeminiOptions extends AssistantAdapterOptions {
  /** The Gemini model id (`gemini-3.5-flash`). */
  model: string;
  /**
   * How much the model reasons before answering. The Google provider maps
   * the level to the model's thinking level, or to a thinking budget on
   * models that take one. Omitted keeps the model's default.
   */
  reasoning?: AssistantReasoning;
}

const geminiOptionsSchema = z.strictObject({
  ...sharedOptions(GEMINI_API_KEY_ENV),
  model: z.string().min(1),
  reasoning: reasoningOption,
});

export type AssistantGeminiAdapter = AdapterDescriptor<
  "gemini",
  AssistantGeminiOptions
>;

export const geminiAdapterSchema = adapterDescriptorSchema(
  "gemini",
  geminiOptionsSchema
);

/**
 * Route the assistant to Google's Gemini API. Reads `GEMINI_API_KEY` and
 * needs `@ai-sdk/google` installed.
 */
export const gemini = (
  options: AssistantGeminiOptions
): AssistantGeminiAdapter => ({
  kind: "gemini",
  options,
  requiredSecrets: [options.apiKeyEnv ?? GEMINI_API_KEY_ENV],
  runtimeDeps: [GEMINI_SDK.pkg],
});

// ---------------------------------------------------------------------------
// grok()
// ---------------------------------------------------------------------------

const GROK_API_KEY_ENV = "XAI_API_KEY";

/** Options for {@link grok}. */
export interface AssistantGrokOptions extends AssistantAdapterOptions {
  /** The Grok model id (`grok-4.7`). */
  model: string;
  /**
   * How much the model reasons before answering, sent as xAI's reasoning
   * effort on the models that take one. Omitted keeps the model's default.
   */
  reasoning?: AssistantReasoning;
}

const grokOptionsSchema = z.strictObject({
  ...sharedOptions(GROK_API_KEY_ENV),
  model: z.string().min(1),
  reasoning: reasoningOption,
});

export type AssistantGrokAdapter = AdapterDescriptor<
  "grok",
  AssistantGrokOptions
>;

export const grokAdapterSchema = adapterDescriptorSchema(
  "grok",
  grokOptionsSchema
);

/**
 * Route the assistant to xAI's Grok models. Reads `XAI_API_KEY` and needs
 * `@ai-sdk/xai` installed.
 */
export const grok = (options: AssistantGrokOptions): AssistantGrokAdapter => ({
  kind: "grok",
  options,
  requiredSecrets: [options.apiKeyEnv ?? GROK_API_KEY_ENV],
  runtimeDeps: [GROK_SDK.pkg],
});

// ---------------------------------------------------------------------------
// openrouter()
// ---------------------------------------------------------------------------

const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

/** Options for {@link openrouter}. */
export interface AssistantOpenRouterOptions extends AssistantAdapterOptions {
  /** The OpenRouter model id (`anthropic/claude-sonnet-4-5`). */
  model: string;
  /**
   * How much the model reasons before answering. Set on the model as
   * OpenRouter's `reasoning.effort`, because its provider ignores the AI
   * SDK's call-level option. Omitted keeps the model's default.
   */
  reasoning?: AssistantReasoning;
}

const openrouterOptionsSchema = z.strictObject({
  ...sharedOptions(OPENROUTER_API_KEY_ENV),
  model: z.string().min(1),
  reasoning: reasoningOption,
});

export type AssistantOpenRouterAdapter = AdapterDescriptor<
  "openrouter",
  AssistantOpenRouterOptions
>;

export const openrouterAdapterSchema = adapterDescriptorSchema(
  "openrouter",
  openrouterOptionsSchema
);

/**
 * Route the assistant through OpenRouter. Reads `OPENROUTER_API_KEY` and needs
 * `@openrouter/ai-sdk-provider` installed in the project.
 */
export const openrouter = (
  options: AssistantOpenRouterOptions
): AssistantOpenRouterAdapter => ({
  kind: "openrouter",
  options,
  requiredSecrets: [options.apiKeyEnv ?? OPENROUTER_API_KEY_ENV],
  runtimeDeps: ["@openrouter/ai-sdk-provider"],
});

// ---------------------------------------------------------------------------
// llmgateway()
// ---------------------------------------------------------------------------

const LLMGATEWAY_API_KEY_ENV = "LLMGATEWAY_API_KEY";

/** Options for {@link llmgateway}. */
export interface AssistantLlmGatewayOptions extends AssistantAdapterOptions {
  /** Overrides the preset endpoint (`https://api.llmgateway.io/v1`). */
  baseUrl?: string;
  /** The model id LLMGateway serves. */
  model: string;
  /**
   * How much the model reasons before answering, sent in the request as
   * `reasoning_effort`. Omitted keeps the model's default.
   */
  reasoning?: AssistantReasoning;
}

const llmgatewayOptionsSchema = z.strictObject({
  ...sharedOptions(LLMGATEWAY_API_KEY_ENV),
  baseUrl: z.url().default("https://api.llmgateway.io/v1"),
  model: z.string().min(1),
  reasoning: reasoningOption,
});

export type AssistantLlmGatewayAdapter = AdapterDescriptor<
  "llmgateway",
  AssistantLlmGatewayOptions
>;

export const llmgatewayAdapterSchema = adapterDescriptorSchema(
  "llmgateway",
  llmgatewayOptionsSchema
);

/**
 * Route the assistant through LLMGateway's OpenAI-compatible endpoint. Reads
 * `LLMGATEWAY_API_KEY` and needs `@ai-sdk/openai-compatible` installed.
 */
export const llmgateway = (
  options: AssistantLlmGatewayOptions
): AssistantLlmGatewayAdapter => ({
  kind: "llmgateway",
  options,
  requiredSecrets: [options.apiKeyEnv ?? LLMGATEWAY_API_KEY_ENV],
  runtimeDeps: [OPENAI_COMPATIBLE_DEP],
});

// ---------------------------------------------------------------------------
// inkeep()
// ---------------------------------------------------------------------------

const INKEEP_API_KEY_ENV = "INKEEP_API_KEY";

/**
 * Options for {@link inkeep}. No `reasoning`: Inkeep runs its own QA pipeline
 * behind an OpenAI-compatible endpoint with no reasoning control.
 */
export interface AssistantInkeepOptions extends AssistantAdapterOptions {
  /** Overrides the preset endpoint (`https://api.inkeep.com/v1`). */
  baseUrl?: string;
  /** The Inkeep QA model id. */
  model: string;
}

const inkeepOptionsSchema = z.strictObject({
  ...sharedOptions(INKEEP_API_KEY_ENV),
  baseUrl: z.url().default("https://api.inkeep.com/v1"),
  model: z.string().min(1),
});

export type AssistantInkeepAdapter = AdapterDescriptor<
  "inkeep",
  AssistantInkeepOptions
>;

export const inkeepAdapterSchema = adapterDescriptorSchema(
  "inkeep",
  inkeepOptionsSchema
);

/**
 * Answer with Inkeep, which retrieves from the content indexed in its own
 * dashboard, so Blume leaves it ungrounded and it takes no `reasoning`.
 * Reads `INKEEP_API_KEY` and needs `@ai-sdk/openai-compatible` installed.
 */
export const inkeep = (
  options: AssistantInkeepOptions
): AssistantInkeepAdapter => ({
  kind: "inkeep",
  options,
  requiredSecrets: [options.apiKeyEnv ?? INKEEP_API_KEY_ENV],
  runtimeDeps: [OPENAI_COMPATIBLE_DEP],
});

// ---------------------------------------------------------------------------
// The `ai.assistant.provider` schema
// ---------------------------------------------------------------------------

/** Which backend answers the assistant: the value of `gateway()`, `openai()`, … */
export type AssistantAdapter =
  | AssistantGatewayAdapter
  | AssistantOpenAIAdapter
  | AssistantAnthropicAdapter
  | AssistantGeminiAdapter
  | AssistantGrokAdapter
  | AssistantOpenRouterAdapter
  | AssistantLlmGatewayAdapter
  | AssistantInkeepAdapter;

// ---------------------------------------------------------------------------
// Blume 1 hints
// ---------------------------------------------------------------------------

/**
 * The adapters' `kind`s and the 1.x `ai.ask.provider` names, each with the
 * `blume/ai` factory that takes its place.
 */
const FACTORY_BY_PROVIDER = new Map([
  ["anthropic", "anthropic"],
  ["gateway", "gateway"],
  ["gemini", "gemini"],
  ["grok", "grok"],
  ["inkeep", "inkeep"],
  ["llmgateway", "llmgateway"],
  ["openai", "openai"],
  // 1.x only: an OpenAI-compatible endpoint is `openai()` with a `baseUrl`.
  ["openai-compatible", "openai"],
  ["openrouter", "openrouter"],
]);

/** The 1.x flat `ai.ask` fields: each is now an option of the provider adapter. */
const MOVED_TO_PROVIDER: ReadonlySet<string> = new Set([
  "apiKeyEnv",
  "baseUrl",
  "headers",
  "model",
  "reasoning",
]);

/** The provider an `ai.assistant` object names: a 1.x string or a descriptor's `kind`. */
const assistantProviderNameProbe = z.looseObject({
  provider: z.union([
    z.string(),
    z.looseObject({ kind: z.string() }).transform(({ kind }) => kind),
  ]),
});

/** The factory a failing `ai.assistant` object's provider names, or the gateway. */
const providerFactory = (issue: z.core.$ZodRawIssue): string => {
  const probe = assistantProviderNameProbe.safeParse(issue.input);
  return (
    (probe.success && FACTORY_BY_PROVIDER.get(probe.data.provider)) || "gateway"
  );
};

/**
 * Error params for `ai.assistant`: a 1.x flat provider field (`model`, `apiKeyEnv`,
 * `baseUrl`, `headers`, `reasoning`) names the adapter call it moves into —
 * the one the object's `provider` picks, 1.x string or descriptor — instead
 * of Zod's bare "Unrecognized key"; any other unknown key keeps its wording.
 */
export const assistantMovedFieldsHint = {
  error: (issue: z.core.$ZodRawIssue): string | undefined => {
    if (issue.code !== "unrecognized_keys") {
      return;
    }
    const moved = issue.keys.filter((key) => MOVED_TO_PROVIDER.has(key));
    if (moved.length === 0) {
      return;
    }
    const fields = moved.map((key) => `ai.assistant.${key}`).join(", ");
    const hint = `${fields} moved into the provider adapter: \`provider: ${providerFactory(issue)}({ ${moved.join(", ")} })\`, imported from "blume/ai".`;
    const others = issue.keys.filter((key) => !MOVED_TO_PROVIDER.has(key));
    return others.length > 0
      ? `${hint} ${unrecognizedKeysMessage(others)}`
      : hint;
  },
};

/** A value that is a 1.x provider name, for the `ai.assistant.provider` hint. */
const providerNameProbe = z.string();

/**
 * The message for an `ai.assistant.provider` that isn't a descriptor: a 1.x
 * provider name names the factory that replaced it; anything else lists them.
 */
const providerNotAdapterMessage = (issue: z.core.$ZodRawIssue): string => {
  const name = providerNameProbe.safeParse(issue.input);
  const factory = name.success ? FACTORY_BY_PROVIDER.get(name.data) : undefined;
  return factory
    ? `ai.assistant.provider takes an adapter from "blume/ai", not a provider name: \`provider: ${factory}({ model })\`. The 1.x model, apiKeyEnv, baseUrl, headers, and reasoning fields move into the call.`
    : 'ai.assistant.provider takes an adapter from "blume/ai": openai(), anthropic(), gemini(), grok(), gateway(), openrouter(), llmgateway(), or inkeep().';
};

/**
 * `ai.assistant.provider`: the descriptor an adapter factory returned, validated
 * against that adapter's own option schema. A value that isn't a descriptor
 * at all (a 1.x provider name) names the factory that replaced it.
 */
export const assistantAdapterSchema = z.discriminatedUnion(
  "kind",
  [
    gatewayAdapterSchema,
    openaiAdapterSchema,
    anthropicAdapterSchema,
    geminiAdapterSchema,
    grokAdapterSchema,
    openrouterAdapterSchema,
    llmgatewayAdapterSchema,
    inkeepAdapterSchema,
  ],
  {
    // A non-object (a 1.x provider name) fails before any discriminator is
    // read — `invalid_type` at runtime, though Zod types the union's own
    // issues as `invalid_union` only; a bad `kind` keeps Zod's message.
    error: (issue) =>
      issue.code === "invalid_union"
        ? undefined
        : providerNotAdapterMessage(issue),
  }
);

/** A resolved (post-defaults) `ai.assistant.provider` descriptor. */
export type AssistantAdapterConfig = z.output<typeof assistantAdapterSchema>;
export type AssistantAdapterKind = AssistantAdapterConfig["kind"];

/** The provider when `ai.assistant.provider` is unset: the gateway with its defaults. */
export const DEFAULT_ASSISTANT_PROVIDER: AssistantAdapter = gateway();

// ---------------------------------------------------------------------------
// Resolved backend
// ---------------------------------------------------------------------------

/** The route fragments an adapter contributes to `askEndpointTemplate`. */
export interface AskBackendTemplate {
  /**
   * Extra `streamText` fields as `key: value` source lines: the adapter's
   * reasoning mapping (when it is a call option) and `providerOptions`.
   */
  fields: string[];
  /** Import lines after the shared `astro` and `astro:env/server` ones. */
  imports: string[];
  /**
   * The up-front credential guard: a statement that returns a 503, since the
   * endpoint exists but can't answer until the deployment sets its key.
   */
  keyCheck: string;
  /** The `model:` expression passed to `streamText`. */
  model: string;
  /** Module-level provider setup (the provider factory call). */
  setup: string;
}

/**
 * What the endpoint template and the diagnostics read from an adapter beyond
 * the descriptor itself (`kind`, `requiredSecrets`, `runtimeDeps` travel on
 * the descriptor; `generate`, `eject`, the required-secrets check, and the
 * runtime-dependency manifest read those directly).
 */
export interface AskBackend {
  /** Whether Blume grounds answers in the docs (Inkeep retrieves itself). */
  grounded: boolean;
  /**
   * Whether the docs tools are on when `ai.assistant.tools` is unset: yes for
   * the hosted model catalogs, whose models call tools, and no for an
   * OpenAI-compatible backend, which may be a local model that can't.
   */
  toolsByDefault: boolean;
  kind: AssistantAdapterKind;
  /** Human-readable adapter name for diagnostics ("AI Gateway"). */
  label: string;
  /** Appended to the missing-secret warning (an alternative credential, say). */
  secretNote?: string;
  template: AskBackendTemplate;
}

const secretExpr = (env: string): string => `getSecret(${JSON.stringify(env)})`;

/**
 * The `headers` line of a provider factory call. Every provider Blume
 * generates against takes the same option; the OpenAI-compatible provider
 * applies it after the `Authorization` header it derives from the API key, so
 * a custom header can't displace auth. An empty map is dropped so the route
 * only carries `headers` when there is something to send.
 */
const headersLine = (headers?: Record<string, string>): string =>
  headers && Object.keys(headers).length > 0
    ? `\n  headers: ${JSON.stringify(headers)},`
    : "";

/** Refuse a request up front when the adapter's key env var is unset. */
const keyCheck = (env: string): string => `  if (!${secretExpr(env)}) {
    return new Response(
      ${JSON.stringify(`The assistant is not configured: set ${env}.`)},
      { status: 503 }
    );
  }`;

/**
 * The `streamText` fields shared by the adapters that take `reasoning` as the
 * AI SDK's top-level call option, plus the verbatim `providerOptions`.
 */
const callFields = (options: {
  providerOptions?: z.output<typeof providerOptionsSchema>;
  reasoning?: AssistantReasoning;
}): string[] => {
  const fields: string[] = [];
  if (options.reasoning) {
    fields.push(`reasoning: ${JSON.stringify(options.reasoning)}`);
  }
  if (options.providerOptions) {
    fields.push(`providerOptions: ${JSON.stringify(options.providerOptions)}`);
  }
  return fields;
};

const gatewayBackend = (
  options: z.output<typeof gatewayOptionsSchema>
): AskBackend => ({
  grounded: true,
  kind: "gateway",
  label: "AI Gateway",
  secretNote: "on Vercel the gateway can also authenticate via OIDC",
  template: {
    // The gateway maps the AI SDK's top-level `reasoning` to the model's own
    // control (OpenAI's `reasoning_effort`, say).
    fields: callFields(options),
    // The gateway provider reads the key (or Vercel's OIDC token) from the
    // environment itself; passing the key explicitly lets a binding-backed
    // secret store reach it too.
    imports: [
      'import { createGateway, createTextStreamResponse, streamText, toTextStream } from "ai";',
    ],
    keyCheck: `  // The AI Gateway authenticates with an API key or Vercel's OIDC token.
  if (!(${secretExpr(options.apiKeyEnv)} || getSecret("VERCEL_OIDC_TOKEN"))) {
    return new Response(
      ${JSON.stringify(`The assistant is not configured: set ${options.apiKeyEnv} (or deploy on Vercel with OIDC).`)},
      { status: 503 }
    );
  }`,
    model: `gateway(${JSON.stringify(options.model)})`,
    setup: `\nconst gateway = createGateway({
  apiKey: ${secretExpr(options.apiKeyEnv)},${headersLine(options.headers)}
});\n`,
  },
  toolsByDefault: true,
});

const openrouterBackend = (
  options: z.output<typeof openrouterOptionsSchema>
): AskBackend => {
  // The OpenRouter provider ignores the AI SDK's top-level `reasoning` call
  // option and only reads its own model-level setting, so the level rides on
  // the model as `reasoning.effort` and nowhere else.
  const settings = options.reasoning
    ? `, { reasoning: { effort: ${JSON.stringify(options.reasoning)} } }`
    : "";
  return {
    grounded: true,
    kind: "openrouter",
    label: "OpenRouter",
    template: {
      fields: callFields({ providerOptions: options.providerOptions }),
      imports: [
        'import { createTextStreamResponse, streamText, toTextStream } from "ai";',
        'import { createOpenRouter } from "@openrouter/ai-sdk-provider";',
      ],
      keyCheck: keyCheck(options.apiKeyEnv),
      model: `openrouter(${JSON.stringify(options.model)}${settings})`,
      setup: `\nconst openrouter = createOpenRouter({
  apiKey: ${secretExpr(options.apiKeyEnv)},${headersLine(options.headers)}
});\n`,
    },
    toolsByDefault: true,
  };
};

/**
 * The backend shared by the adapters that stream through the AI SDK's
 * OpenAI-compatible provider, which sends the top-level `reasoning` call
 * option as `reasoning_effort`.
 */
const openaiCompatibleBackend = (
  kind: AssistantAdapterKind,
  label: string,
  grounded: boolean,
  toolsByDefault: boolean,
  options: {
    apiKeyEnv: string;
    baseUrl: string;
    headers?: Record<string, string>;
    model: string;
    name: string;
    providerOptions?: z.output<typeof providerOptionsSchema>;
    reasoning?: AssistantReasoning;
  }
): AskBackend => ({
  grounded,
  kind,
  label,
  template: {
    fields: callFields(options),
    imports: [
      'import { createTextStreamResponse, streamText, toTextStream } from "ai";',
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
    ],
    keyCheck: keyCheck(options.apiKeyEnv),
    model: `provider(${JSON.stringify(options.model)})`,
    // `headers` sits between the key and the name so the API key's
    // `Authorization` header is applied first.
    setup: `\nconst provider = createOpenAICompatible({
  apiKey: ${secretExpr(options.apiKeyEnv)},
  baseURL: ${JSON.stringify(options.baseUrl)},${headersLine(options.headers)}
  name: ${JSON.stringify(options.name)},
});\n`,
  },
  toolsByDefault,
});

/**
 * The backend for a provider Blume calls directly, through that provider's
 * own AI SDK package, which maps the top-level `reasoning` call option to the
 * model's control itself. Their models all call tools.
 */
const directBackend = (
  kind: AssistantAdapterKind,
  label: string,
  sdk: { factory: string; pkg: string },
  options: {
    apiKeyEnv: string;
    headers?: Record<string, string>;
    model: string;
    name?: string;
    providerOptions?: z.output<typeof providerOptionsSchema>;
    reasoning?: AssistantReasoning;
  }
): AskBackend => ({
  grounded: true,
  kind,
  label,
  template: {
    fields: callFields(options),
    imports: [
      'import { createTextStreamResponse, streamText, toTextStream } from "ai";',
      `import { ${sdk.factory} } from ${JSON.stringify(sdk.pkg)};`,
    ],
    keyCheck: keyCheck(options.apiKeyEnv),
    model: `provider(${JSON.stringify(options.model)})`,
    setup: `\nconst provider = ${sdk.factory}({
  apiKey: ${secretExpr(options.apiKeyEnv)},${headersLine(options.headers)}${
    options.name ? `\n  name: ${JSON.stringify(options.name)},` : ""
  }
});\n`,
  },
  toolsByDefault: true,
});

/**
 * `openai()`: OpenAI itself through its own SDK, or, with a `baseUrl`, a
 * generic endpoint through the OpenAI-compatible provider — Chat Completions,
 * which most such endpoints serve where the Responses API isn't — with the
 * tools off by default, since a self-hosted model may not call them.
 */
const openaiBackend = (
  options: z.output<typeof openaiOptionsSchema>
): AskBackend => {
  const { baseUrl } = options;
  return baseUrl
    ? openaiCompatibleBackend("openai", "OpenAI-compatible", true, false, {
        ...options,
        baseUrl,
        name: options.name ?? "openai-compatible",
      })
    : directBackend("openai", "OpenAI", OPENAI_SDK, options);
};

/** Resolve a parsed `ai.assistant.provider` descriptor into its backend. */
export const resolveAskBackend = (
  provider: AssistantAdapterConfig = assistantAdapterSchema.parse(
    DEFAULT_ASSISTANT_PROVIDER
  )
): AskBackend => {
  switch (provider.kind) {
    case "gateway": {
      return gatewayBackend(provider.options);
    }
    case "anthropic": {
      return directBackend(
        "anthropic",
        "Anthropic",
        ANTHROPIC_SDK,
        provider.options
      );
    }
    case "gemini": {
      return directBackend("gemini", "Gemini", GEMINI_SDK, provider.options);
    }
    case "grok": {
      return directBackend("grok", "Grok", GROK_SDK, provider.options);
    }
    case "openrouter": {
      return openrouterBackend(provider.options);
    }
    case "llmgateway": {
      return openaiCompatibleBackend("llmgateway", "LLMGateway", true, true, {
        ...provider.options,
        name: "llmgateway",
      });
    }
    case "inkeep": {
      // Inkeep answers from the content indexed in its dashboard, so injected
      // excerpts would conflict with its own retrieval.
      return openaiCompatibleBackend("inkeep", "Inkeep", false, false, {
        ...provider.options,
        name: "inkeep",
      });
    }
    default: {
      return openaiBackend(provider.options);
    }
  }
};
