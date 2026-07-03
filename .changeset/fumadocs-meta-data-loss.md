---
"blume": patch
---

The Fumadocs migrator no longer deletes a `meta.json` whose conversion was skipped. When a `docs/<dir>/meta.ts` already existed at the destination, the migrator skipped writing the converted meta but still removed the source `meta.json` — permanently losing its title and page ordering. The source file is now kept alongside a warning telling you to merge it by hand, matching how page collisions already behave.
