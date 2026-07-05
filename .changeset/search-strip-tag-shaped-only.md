---
"blume": patch
---

Strip only tag-shaped `<name …>` markup when building the search index: a bare `<` in prose ("costs < 5 credits") no longer deletes everything up to the next `>` — potentially whole paragraphs — from search results.
