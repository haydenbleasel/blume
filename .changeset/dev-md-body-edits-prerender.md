---
"blume": patch
---

`blume dev` now shows a body edit to a `.md` page on sites whose content pages render in Astro's `prerender` environment, such as sites deployed with `cloudflare()`. Astro refreshes its content store in the `ssr` environment only, so the page kept rendering its old body until something structural changed or the dev server restarted.
