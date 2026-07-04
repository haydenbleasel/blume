---
"blume": patch
---

Exclude dependency, output, and cache trees from the generated Astro content collection. The content-layer glob previously only skipped `node_modules`, so a `.`-rooted `content.root` re-ingested build output — for example a prior `dist/*.mdx` render — and crashed the build in rolldown with an unresolvable `astro:content-layer-deferred-module` import. It now mirrors the content scan's baseline ignores (`node_modules`, `.git`, `.vercel`, `dist`, `.next`, `.turbo`, `.cache`), while the runtime directory (`.blume`, or a custom `distDir`) stays excluded precisely by the existing output-dir handling.
