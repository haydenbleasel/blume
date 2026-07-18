---
"blume": patch
---

Stop shipping underscore-prefixed `.astro` files in `pages/` as routes. Blume injects user pages itself and globbed every `.astro` file, so private partials — shared layouts and home-page sections like `pages/_home/Hero.astro` or `pages/_FeatureBrowser.astro` — were each built into their own HTML page. Page discovery now honors Astro's convention: any file or folder whose name starts with `_` stays importable but is never routed.
