---
"blume": patch
---

Add `search.indexing.includeCodeBlocks` to index fenced code (body and title) in the source-built search indexes — the client index, hosted syncs, and the MCP `search_docs` tool — while keeping the plain-text default. `.mdx` pages are now parsed as MDX for indexing, so prose and fences inside components (`<Steps>`, `<Tabs>`) and their text props (`title`, `description`, `label`, `caption`) are read like top-level content instead of being folded into raw HTML.
