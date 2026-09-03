---
"blume": patch
---

Load the font subsets your locales need. Remote fonts used to load only the Latin subset, so Vietnamese, Central European, Cyrillic, and Greek text fell back to the system font. Blume now derives subsets from `i18n.locales`, and remote families accept a `subsets` option to pin the list.
