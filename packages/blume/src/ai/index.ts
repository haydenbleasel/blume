/**
 * Ask AI provider adapters for `blume.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { openrouter } from "blume/ai";
 *
 * export default defineConfig({
 *   ai: {
 *     ask: {
 *       enabled: true,
 *       provider: openrouter({ model: "anthropic/claude-sonnet-4-5" }),
 *     },
 *   },
 * });
 * ```
 *
 * Each factory returns a plain descriptor (see `core/adapter.ts`) that the
 * schema validates and the generated `/api/ask` route inlines as literals;
 * nothing here runs at request time.
 */
export {
  gateway,
  inkeep,
  llmgateway,
  openaiCompatible,
  openrouter,
} from "./ask.ts";
export type {
  AskAdapter,
  AskAdapterOptions,
  AskGatewayAdapter,
  AskGatewayOptions,
  AskInkeepAdapter,
  AskInkeepOptions,
  AskLlmGatewayAdapter,
  AskLlmGatewayOptions,
  AskOpenAICompatibleAdapter,
  AskOpenAICompatibleOptions,
  AskOpenRouterAdapter,
  AskOpenRouterOptions,
  AskProviderOptions,
  AskReasoning,
} from "./ask.ts";
export type { AdapterDescriptor } from "../core/adapter.ts";
