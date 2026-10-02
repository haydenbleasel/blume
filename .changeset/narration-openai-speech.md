---
"blume": minor
---

Narration can generate voices with `openai()` from `blume/ai`, not only `gateway()`. `narration: { provider: openai({ model, voice }) }` uses OpenAI's speech models, and with a `baseUrl` any server that serves OpenAI's `/audio/speech` endpoint, such as a self-hosted Kokoro-FastAPI, Speaches, or LiteLLM, so a site whose build can't reach a hosted service still gets generated voices. With a `baseUrl`, only the key `apiKeyEnv` names is sent, so `OPENAI_API_KEY` never reaches another server, and with none named the build calls the server without a bearer token instead of skipping generation. It speaks through `@ai-sdk/openai`, which `blume build` and `blume doctor` report when it isn't installed. Clips are cached per server, and `gateway()` clips keep their cache keys.
