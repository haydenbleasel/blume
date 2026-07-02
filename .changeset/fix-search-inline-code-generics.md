---
"blume": patch
---

Keep angle-bracket type parameters inside inline code in the search index. When reducing Markdown to searchable text, the HTML/JSX strip ran before inline code was unwrapped, so `` `Array<Item>` `` indexed as just `Array` — searches for `Item`, `Response`, `u8`, and the like silently missed. Inline-code contents are now preserved through the HTML strip, in both the on-page and MCP/Ask AI indexes.
