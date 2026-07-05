---
"blume": patch
---

Remove `markdown.math` and `markdown.code.inline` from the `BlumeConfig` authoring type — both features are always-on and the strict config schema rejects the keys, so configs written from autocomplete failed to load.
