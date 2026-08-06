---
"blume": minor
---

Add declared facets: `content.types.<type>.facets` names custom frontmatter keys whose values become filterable metadata. Faceted values ride along on search documents (`blume-search.json` and the MCP snapshot), and the MCP `search_docs` and `list_pages` tools accept a `filters` object matching against them (`{"domain": "architecture", "status": "enforced"}`, every entry must match) — so a knowledge base holding RFCs, runbooks, or policies can drive progressive-disclosure agent workflows straight off its static content. Results carry their facet values, `list_pages` shows each page's, and the shared Orama index gains a `facetTerms` enum-array field so one static schema serves every project's facet keys. Each facet name must be a declared custom key (per-type or `frontmatter.extend`, validated at config load), and string, number, and boolean values facet — numbers and booleans stringified.
