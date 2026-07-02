---
"blume": patch
---

Don't let one missing file abort a whole remote Markdown source. The `files` mode fetched every file in a single `Promise.all`, so a single 404 (a page renamed or deleted upstream) rejected the batch and failed a cache-less build with none of the healthy pages imported. Failed files are now skipped with a per-file warning and the rest import; a source only hard-fails when _every_ file fails (so it can still fall back to cache or surface a real outage).
