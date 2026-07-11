---
"blume": patch
---

Corrected a stale comment in `scripts/bundle-docs.mjs`: the script runs on the repo root's `prepare` and the package's `prepack` — the package itself defines no `prepare` script.
