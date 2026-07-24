---
"blume": patch
---

Fix the EPUB page action failing in dev with `epub is not a function`. `epub-gen-memory`'s browser bundle is a browserified UMD, and its dynamic import lives inside `node_modules/blume`, which Vite's optimizer scan doesn't crawl — so in dev it was served as raw ESM, where the UMD finds no `exports`/`define`, exposes no `default`, and strands its callable on `window.epubGen`. It now joins mermaid in `optimizeDeps.include`, naming the `/bundle` subpath that is actually imported, since optimizing the package root leaves that entry unoptimized. Production builds already bundled it correctly and are unchanged.
