---
"blume": minor
---

Warn when an index page's own frontmatter `title` diverges from its folder's explicit `meta.title`. The two are resolved independently, so a translator can update one and forget the other — the sidebar looks right while the page's own `<title>`/heading stays stale. Reported as `BLUME_NAV_INDEX_TITLE_MISMATCH` from `blume doctor`/`blume check`.
