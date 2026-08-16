---
"blume": patch
---

Add `ai.ask.retrieval` — `maxResults`, `excerptChars`, and `contextBudget` — so a site can size how much documentation each Ask AI question injects into the model's prompt. Injected characters are the dominant term in time-to-first-token, and on a self-hosted backend the fixed 10,000-character grounding could push a single question past 40 seconds. The three knobs stay separate because they aren't interchangeable: `contextBudget` caps the total, `excerptChars` decides how deep into one long page an excerpt reaches, and `maxResults` is the ceiling on how many pages an answer can cite. Defaults are unchanged (6 / 2000 / 10000), so existing sites behave exactly as before.
