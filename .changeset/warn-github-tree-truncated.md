---
"blume": patch
---

Warn when a GitHub remote source hits the tree-listing limit. The git-trees API
caps very large repos and sets `truncated: true`, which was ignored — so a big
repo would silently enumerate only part of its files with no indication. Blume
now emits a `BLUME_SOURCE_TRUNCATED` warning when that happens.
