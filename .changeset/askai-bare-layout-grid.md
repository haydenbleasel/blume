---
"blume": patch
---

Opening Ask AI on a "bare" layout page (the changelog index) forced the docs sidebar grid tracks onto its single-column grid, squeezing the whole page into the 17.5rem sidebar track on desktop. The column override now only applies to grids that actually have a TOC column, so bare pages just shrink to make room for the panel like every other layout.
