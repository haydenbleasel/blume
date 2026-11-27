---
"blume": patch
---

Import table blocks from Notion pages. A table previously rendered as an `unsupported Notion block` comment, so the page lost it. A table now becomes a Markdown table, following the rules Blume uses for a Contentful table: the first row is the header, because a Markdown table needs one; a line break in a cell becomes a space; and a `|` in a cell is escaped so it stays in that cell, in inline code too. With `mdx: true`, a cell's text is read as MDX, like the rest of the page's text.
