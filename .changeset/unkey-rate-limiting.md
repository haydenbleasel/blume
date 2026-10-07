---
"blume": patch
---

Add an `unkey()` rate limiter to `blume/ratelimit`. It counts through Unkey's rate limit API with the root key in `UNKEY_ROOT_KEY` (or the env var `rootKeyEnv` names), in the namespace `namespace` names (`docs` by default), on any host and with nothing to install. Until the key is set, the routes count in memory and `blume build` warns. A request Unkey doesn't count within two seconds is let through, like one it fails to count.
