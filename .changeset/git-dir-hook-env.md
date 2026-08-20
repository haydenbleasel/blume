---
"blume": patch
---

Ignore repo-locating `GIT_*` environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and friends) when resolving git last-modified dates and shallow-clone status. A parent git process exports an absolute `GIT_DIR` to its hooks, so a build run from inside one — a husky hook, a post-merge script, a CI wrapper — silently read the wrong repository and dropped every page's date.
