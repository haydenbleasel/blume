---
"blume": patch
---

Add `search.indexing.includeCodeBlocks` to index fenced code (body and title) in the source-built search indexes — the client index, hosted syncs, and the MCP `search_docs` tool — while keeping the plain-text default. Fences nested tightly inside JSX components now follow the same rule instead of being indexed as raw text.
