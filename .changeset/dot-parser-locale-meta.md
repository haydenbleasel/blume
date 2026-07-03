---
"blume": patch
---

Folder `meta.ts` files now apply to every locale under the `dot` i18n parser. Non-default locales looked meta up under a locale-prefixed key (`fr/guides`) that only exists in the `dir` layout, so with `parser: "dot"` — where translations sit next to the originals — translated sidebars silently lost their configured titles, ordering, icons, and collapsed state and fell back to humanized folder names. Locale-prefixed lookups now only happen under the `dir` parser.
