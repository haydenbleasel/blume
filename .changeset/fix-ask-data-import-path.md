---
"blume": patch
---

Fix the grounded **Ask AI** endpoint failing to build. The generated
`/api/ask` route lives at `src/pages/api/ask.ts` but imported its retrieval
data from `../generated/ask-data.json`, which resolves one directory too high
(`src/pages/generated/…`) and doesn't exist. It now climbs two levels
(`../../generated/ask-data.json`), matching the other depth-two endpoints, so
Ask AI builds under the default (gateway) provider and every grounded backend.
