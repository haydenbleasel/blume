---
"blume": minor
---

Add `--isolated` to `blume build` and `blume check` so you can build/verify while a `blume dev` server is running. Both commands regenerate the shared `.blume/` runtime, so running them against a live dev server would corrupt it — `build` refused and `check` (which had no guard) silently corrupted it. `--isolated` relocates the whole generated runtime — and, for `build`, its `dist/` output — to a throwaway `.blume-verify/` sibling (auto-gitignored), leaving the dev server's `.blume/` and your real `dist/` untouched. Isolated builds skip the deploy post-steps (search index, hosted-provider sync, `llms.txt`, sitemap/robots, redirects) since a verify only needs to confirm the site compiles and renders. `check` now also refuses a live dev server when not isolated, the refusal message points at `--isolated`, and `BLUME_RUNTIME_DIR` lets plain `build`/`check` isolate without the flag (useful for coding agents verifying changes alongside an open dev server).
