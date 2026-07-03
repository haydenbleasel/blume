---
"blume": patch
---

Harden remote OpenAPI spec loading and stop a failed fetch from shipping a dead reference tab. Remote (`http(s)`) specs are now fetched defensively — bounded by a per-attempt timeout, retried with backoff on transient failures (network errors, timeouts, 408/425/429/5xx, honoring `Retry-After`), sent with a User-Agent, routed through an HTTP(S) proxy when `HTTP(S)_PROXY` is set (Node's `fetch` ignores proxy env vars on its own, the classic "curl works but the build doesn't" gap), and cached on disk so a transient outage falls back to the last good copy with a warning instead of dropping the reference. A spec that still can't be loaded is now an error in `build` (a configured reference otherwise ships a nav tab pointing at a route that was never generated — a silent 404) while staying a warning in `dev` so offline work keeps running.
