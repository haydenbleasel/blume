---
"blume": patch
---

Generated OG cards now show the page's own description as the subtitle (its `seo.description`, else `description`), matching the page's `og:description`, and fall back to the site-wide `seo.og.description` only for pages without one. `seo.og.description: false` still hides the subtitle on every card.
