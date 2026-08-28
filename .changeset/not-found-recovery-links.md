---
"blume": patch
---

The default 404 page now helps readers and agents recover instead of dead-ending. Under a "Where to look next" heading it links every top-level section (each tab's resolved target), the sitemap when a `deployment.site` makes one possible, and `llms.txt` when it's enabled — so an agent that followed a stale URL lands on a real HTTP 404 whose body points at the site map and the docs index. The three new labels (`notFound.suggestions`, `notFound.sitemap`, `notFound.llms`) are translatable through `ui` like the rest of the page's copy.
