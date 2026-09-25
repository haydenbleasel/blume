---
"blume": patch
---

Blume now warns when a content folder is named after the default locale (`docs/en/` with `defaultLocale: "en"`). The default locale's pages live at the content root, so such a folder is ordinary content that publishes at `/en/…` (`/en/en/…` when the default locale keeps its prefix, and `/fr/en/…` as fallbacks); before, it did so silently.
