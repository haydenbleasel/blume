---
"blume": patch
---

The first search in a fresh `blume dev` session no longer reloads the page. The configured search adapter's browser library (`@orama/orama` for the default search, or the FlexSearch, Algolia, Orama Cloud, or Typesense client) is now pre-bundled when the dev server starts. It used to be discovered only when the search dialog first opened, which re-optimized dependencies and reloaded the page.
