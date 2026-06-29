import type { AskAiConfig } from "../core/schema.ts";

/**
 * The concrete backend the Ask AI endpoint is generated against. `gateway` uses
 * the AI SDK core (`streamText({ model })`) and the Vercel AI Gateway;
 * `openrouter` uses its dedicated provider; everything else streams through the
 * AI SDK's OpenAI-compatible provider.
 */
export type AskBackend =
  | { kind: "gateway"; model: string }
  | { apiKeyEnv: string; kind: "openrouter"; model: string }
  | {
      apiKeyEnv: string;
      baseUrl: string;
      kind: "openai-compatible";
      model: string;
      name: string;
    };

interface AskPreset {
  apiKeyEnv: string;
  baseUrl?: string;
  kind: "openai-compatible" | "openrouter";
  name: string;
  runtimeDep: string;
}

/**
 * Connection presets for the named, non-gateway providers. OpenRouter has a
 * dedicated AI SDK provider; LLMGateway and Inkeep are OpenAI-compatible
 * endpoints with no dedicated provider, so they reuse `@ai-sdk/openai-compatible`.
 */
const ASK_PRESETS: Record<string, AskPreset> = {
  inkeep: {
    apiKeyEnv: "INKEEP_API_KEY",
    baseUrl: "https://api.inkeep.com/v1",
    kind: "openai-compatible",
    name: "inkeep",
    runtimeDep: "@ai-sdk/openai-compatible",
  },
  llmgateway: {
    apiKeyEnv: "LLMGATEWAY_API_KEY",
    baseUrl: "https://api.llmgateway.io/v1",
    kind: "openai-compatible",
    name: "llmgateway",
    runtimeDep: "@ai-sdk/openai-compatible",
  },
  openrouter: {
    apiKeyEnv: "OPENROUTER_API_KEY",
    kind: "openrouter",
    name: "openrouter",
    runtimeDep: "@openrouter/ai-sdk-provider",
  },
};

const DEFAULT_MODEL = "openai/gpt-5.5";

/** Resolve the `ai.ask` config into the backend the endpoint is built against. */
export const resolveAskBackend = (ask?: AskAiConfig): AskBackend => {
  const provider = ask?.provider ?? "gateway";
  const model = ask?.model ?? DEFAULT_MODEL;
  if (provider === "gateway") {
    return { kind: "gateway", model };
  }
  const preset = ASK_PRESETS[provider];
  const apiKeyEnv = ask?.apiKeyEnv ?? preset?.apiKeyEnv ?? "API_KEY";
  if (provider === "openrouter") {
    return { apiKeyEnv, kind: "openrouter", model };
  }
  // `llmgateway`, `inkeep`, and the generic `openai-compatible` provider all
  // stream through the AI SDK's OpenAI-compatible provider. The schema requires
  // `baseUrl` for the generic case; the named providers fall back to a preset.
  return {
    apiKeyEnv,
    baseUrl: ask?.baseUrl ?? preset?.baseUrl ?? "",
    kind: "openai-compatible",
    model,
    name: preset?.name ?? "openai-compatible",
  };
};

/**
 * The provider SDK a project must install for the configured backend, or
 * `undefined` for `gateway` (which only needs the core `ai` package). Declared
 * in the generated runtime so a project pulls in exactly the backend it uses.
 */
export const askBackendRuntimeDep = (ask?: AskAiConfig): string | undefined => {
  const provider = ask?.provider ?? "gateway";
  if (provider === "gateway") {
    return undefined;
  }
  return ASK_PRESETS[provider]?.runtimeDep ?? "@ai-sdk/openai-compatible";
};
