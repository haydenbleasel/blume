---
"blume": patch
---

Fix `deployment.base` so a subdirectory deploy (e.g. GitHub Pages project sites) prefixes everything it renders, not just bundled assets. Previously Astro prefixed `_astro/*`/fonts/CSS but Blume's own output stayed base-less, so navigation links, in-content Markdown links, canonical URLs, Open Graph images, the sitemap, `llms.txt`, RSS feeds, JSON-LD, `agent-readability.json`, the robots `Sitemap:` line, and search-result links all pointed at the wrong (base-less) path. Each is now prefixed with the deployment base at the point it's emitted — via `import.meta.env.BASE_URL` in components and templates, and `deployment.base` in the build-time SEO files — while active-route matching stays in base-less logical space. Composes with the new site-wide `basePath`: with both set, a link resolves to `{deployment.base}/{basePath}/page`.
