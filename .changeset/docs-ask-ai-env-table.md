---
"blume": patch
---

The deployment docs' env-var table understated the Ask AI warning — it fires for every non-gateway provider's default key env var (`OPENROUTER_API_KEY`, `LLMGATEWAY_API_KEY`, `INKEEP_API_KEY`) unless `apiKeyEnv` overrides it — and the sources page's `blume sync --force` comment is now aligned with the lines above it.
