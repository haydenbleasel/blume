---
"blume": patch
---

`blume eject` rewrote the build script to plain `astro build` without mentioning that the `blume build` post-build artifacts stop being produced — most severely, a `search.provider: "pagefind"` site ejected into a build whose search fails at runtime because the Pagefind index is never created. The eject confirmation and summary now warn exactly which artifacts the project's config actually uses (the Pagefind index with a `pagefind --site dist` post-build hint, hosted search sync, llms.txt/llms-full.txt, sitemap.xml, robots.txt, agent-readability.json, and platform redirect files), and the Eject docs explain how to recreate each one.
