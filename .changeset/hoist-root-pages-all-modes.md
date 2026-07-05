---
"blume": patch
---

Hoist root-level pages above groups in every sidebar display mode. Previously only `flat` pulled loose top-level pages to the top; now `group` and `page` modes do too, so a root page never reads as a group's trailing child. Deep per-level hoisting remains exclusive to `flat`.
