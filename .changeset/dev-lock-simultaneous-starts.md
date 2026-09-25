---
"blume": patch
---

Two `blume dev` servers started at the same moment in one project no longer both get the `.blume` lock. The lock file now appears with its content already written, a lock that's still being written is waited on instead of being read as stale, and a stale lock left by a stopped server is cleared by one process at a time, so a starting server can't delete the lock another one claimed a moment earlier.
