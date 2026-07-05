---
"blume": patch
---

Decode Ask AI streams with `{ stream: true }` (in both the built-in panel and `useAskAI`), so multi-byte characters split across network chunks no longer render as `�`.
