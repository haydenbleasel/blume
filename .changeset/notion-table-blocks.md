---
"blume": patch
---

Import table blocks from Notion pages. A table previously rendered as an `unsupported Notion block` comment, so the page lost it. A table now becomes a Markdown table: its header row is the table's header, and a table whose header row is off in Notion renders without one. A line break in a cell becomes a space, and a `|` in a cell stays in that cell. A cell's text is never read as MDX, with `mdx: true` too.
