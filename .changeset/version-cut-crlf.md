---
"blume": patch
---

`blume version <id>` now preserves the line endings of a CRLF `blume.config.ts` when it inserts the new entry into `versions.archived`, instead of introducing a lone LF ahead of the entry.
