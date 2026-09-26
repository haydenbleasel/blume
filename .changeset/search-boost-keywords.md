---
"blume": patch
---

Rank pages with `search.boost` and `search.keywords` frontmatter. `boost` multiplies a page's search relevance: above 1 moves it up, below 1 moves it down. The default Orama search, FlexSearch, the MCP server, and the assistant apply it exactly. Pagefind weighs a boosted page's text more heavily, Algolia and Typesense sort by it among close matches, and Orama Cloud re-sorts a wider set of results. `keywords` are extra terms a page is found by, beyond its own text. Blume 1 accepted `search.boost` without reading it, so a page that still sets it now ranks by it. The Mintlify migration moves `keywords`, `boost`, and `searchable: false` into the `search` block.
