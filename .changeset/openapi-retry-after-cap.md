---
"blume": patch
---

Cap remote-spec retry backoff at 10s: a server answering 429/503 with a large `Retry-After` no longer stalls `blume build` for hours.
