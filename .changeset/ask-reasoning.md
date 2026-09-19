---
"blume": patch
---

Add `ai.ask.reasoning` to set how much the Ask AI model reasons before answering, from `none` to `xhigh`. It is forwarded to the AI SDK's top-level `reasoning` option, so each backend maps it to its own control; leaving it unset keeps the model's default.
