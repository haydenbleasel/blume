---
"blume": major
---

Configure the Ask AI backend with an adapter. `ai.ask.provider` now takes the descriptor one of the new `blume/ai` exports returns — `gateway({ model })`, `openrouter({ model, reasoning })`, `llmgateway({ model })`, `inkeep({ model })`, or `openaiCompatible({ baseUrl, name, model, apiKeyEnv })` — and each adapter owns its model, its API key env var, its `headers`, how it maps `reasoning` to the backend's own control, whether Blume grounds answers, and a verbatim `providerOptions` passthrough to `streamText` for anything else. The flat `provider` name and the `model`, `apiKeyEnv`, `baseUrl`, `headers`, and `reasoning` fields on `ai.ask` are gone; `enabled`, `instructions`, `retrieval`, `suggestions`, `cors`, and `endpoint` are unchanged, and leaving `provider` unset still means the AI Gateway with `openai/gpt-5.5`. Move the old fields into the matching adapter call:

```ts
import { defineConfig } from "blume";
import { openrouter } from "blume/ai";

export default defineConfig({
  ai: {
    ask: {
      enabled: true,
      // was: provider: "openrouter", model: "anthropic/claude-sonnet-4-5", reasoning: "none"
      provider: openrouter({
        model: "anthropic/claude-sonnet-4-5",
        reasoning: "none",
      }),
    },
  },
});
```

The descriptor is plain data, so the generated and ejected routes inline it as literals and never import `blume.config.ts` at request time.
