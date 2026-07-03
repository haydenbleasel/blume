---
"blume": patch
---

The generated Ask AI endpoint now validates message shapes, not just the array size. Previously any JSON array of 1–40 items was forwarded to `streamText` verbatim, so a caller could POST a `role: "system"` message and repurpose the unauthenticated endpoint as a general LLM proxy on the site owner's API key. Each message must now be `{ role: "user" | "assistant", content: string }`, and the array is rebuilt so only those two fields ever reach the model.
