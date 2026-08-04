---
"blume": patch
---

Header tab labels (and tab dropdown item labels) accept a per-locale map alongside the plain-string form: `label: { en: "Docs", fr: "Documentation" }`. Each locale's navigation resolves its own entry, falling back to the default locale's and then the map's first entry, so an i18n site can translate its header without forking the config.
