---
"blume": minor
---

Per-group sidebar display modes on the generated sidebar. A folder can opt its group into `flat`, `group`, or `page` without an explicit `navigation.sidebar` config: set `display` in the folder's `meta.ts`, or — sugar for folders with an `index` page — `sidebar.display` in the index page's frontmatter. A generated group's effective mode resolves index frontmatter first, then folder meta, then the global `navigation.sidebar.display`, then the `flat` default; a group's value applies to that group only, and nested subgroups resolve their own chain. `page`-mode drill-in panels stay route-aware, list the index page first, and `sidebar.display` on a non-index page reports a new `BLUME_SIDEBAR_DISPLAY_IGNORED` warning instead of being silently dropped. Explicit config sidebars behave exactly as before.
