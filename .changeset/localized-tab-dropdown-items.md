---
"blume": patch
---

Localize header-tab dropdown item paths under i18n: a tab's own path was locale-prefixed (`/docs` -> `/fr/docs`) but its `items[].path` entries were not, so dropdown links always pointed at the default locale. External item URLs still pass through untouched, and selector items keep their intentionally locale-specific targets.
