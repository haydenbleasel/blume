---
"blume": patch
---

Support a dark-mode favicon. A dark mark is invisible against dark browser chrome, so Blume now auto-detects a `-dark` sibling of any icon filename — `icon-dark.svg`, `favicon-dark.png`, `icon-dark.ico`, and so on — in your project root or `public/` directory, and emits both icons behind `media="(prefers-color-scheme: …)"`. Ship one icon and nothing changes: a single `<link rel="icon">`, as before. The bundled Blume fallback mark now ships a light variant for dark mode too, so a site with no icon of its own no longer has a favicon that vanishes in dark mode.
