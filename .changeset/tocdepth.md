---
"blume": patch
---

Emit `data-depth` on each table-of-contents item. The heading's level was computed and then written only into an inline `padding-inline-start`, so a project wanting to style the rail by level had to match on that style string — which breaks silently if the indent ever changes.
