---
"blume": patch
---

Widen the dev watcher's ignore set to cover build and deploy caches. Alongside `.blume`, `.git`, and `node_modules`, the recursive content watcher now also ignores `.vercel`, `dist`, `.next`, `.turbo`, and `.cache`, sharing one canonical directory list with the content scan so the two never disagree about what counts as content. This keeps churn from build output and framework caches from needlessly re-triggering a rescan during `blume dev`.
