---
"blume": patch
---

`blume dev` now refreshes Blume's generated data in every Vite environment, not only the ones Vite's legacy module graph covers. On sites whose content pages render in Astro's `prerender` environment, such as sites deployed with `cloudflare()`, a page added while the dev server runs now opens instead of 404ing, sidebar label edits show up, `.md` mirrors follow body edits, and an edit to an included partial reaches the pages that include it. Until now they all kept their startup state until the dev server restarted.
