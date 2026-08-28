---
"blume": patch
---

Add `search.indexing.includeCodeBlocks` to index fenced code (body and title) in the source-built search indexes — the client index, hosted syncs, and the MCP `search_docs` tool — while keeping the plain-text default. `.mdx` pages are now parsed as MDX for indexing, and components are downleveled with the same serializers the agent surfaces use, so prose and fences inside `<Steps>`/`<Tabs>` and the text a `<Card>` or `<TypeTable>` shows are indexed instead of being folded into raw HTML.
