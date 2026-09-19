---
"blume": patch
---

Add `ai.ask.reasoning` to set how much the Ask AI model reasons before answering, from `none` to `xhigh`. The level is sent as each backend's own reasoning-effort control: the AI SDK's `reasoning` option on the gateway, `reasoning.effort` on OpenRouter, and `reasoning_effort` on OpenAI-compatible endpoints. Leaving it unset keeps the model's default.
