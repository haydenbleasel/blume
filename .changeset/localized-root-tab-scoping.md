---
"blume": patch
---

Recognize the localized/based root tab when scoping the sidebar. With i18n enabled and header tabs configured, a non-default locale's tabs arrive localized (`/` becomes `/en`), but render-time scoping compared the active tab against a bare `/` — so on any `/en/...` route the root tab was misread as a section tab, and a root-level `(group)` folder (whose path is exactly the locale prefix) collapsed the sidebar to that one group. The same bare comparison blanked the sidebar entirely under a `basePath` with a root tab. The navigation now carries its root in the tabs' own path space (`/`, `/en`, `/docs`) and the sidebar scoping compares against it, so non-default locales show the full tree minus tab-owned sections, matching the default locale.
