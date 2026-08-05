---
"blume": minor
---

Let MCP clients filter by content type. `search_docs` and `list_pages` accept an optional `contentTypes` array that narrows results to pages of the given frontmatter `type`s (`["rfc"]`, `["blog", "changelog"]`), so an agent working against a site that mixes docs with RFCs, runbooks, or policies can scope retrieval to the kind of page it needs. Search hits now name their content type alongside the title, route, and excerpt, search documents carry the resolved type end to end (`blume-search.json` included), and the shared Orama index gains a `contentType` enum field filtered with an exact `where` match — the same mechanism the locale filter uses.
