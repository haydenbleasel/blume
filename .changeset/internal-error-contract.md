---
"blume": patch
---

Unexpected (non-`BlumeError`) failures now print a stable internal-error report —
a fixed `BLUME_INTERNAL` code, the message, a trimmed stack, and an environment
dump (Blume/Node/platform) with a link to file an issue — instead of a bare stack
trace. Wired into `prepare`, `validate`, and `doctor`, plus a top-level backstop
for async failures that escape a command (e.g. in `blume dev`).
