---
"blume": patch
---

Support a dark-mode favicon. A dark mark is invisible against dark browser chrome, so Blume now auto-detects a `-dark` sibling of your icon file — the same name and directory with `-dark` before the extension, like `icon.svg` → `icon-dark.svg` — and emits both icons behind `media="(prefers-color-scheme: …)"`, preceded by a plain light link so crawlers and browsers that ignore media queries on icons still get a sensible mark. Only the sibling of the icon Blume resolved is picked up, so an unrelated `-dark` file can't pair with your mark by accident. Ship one icon and nothing changes: a single `<link rel="icon">`, as before. The bundled Blume fallback now ships a light variant too, so a site with no icon of its own keeps a visible favicon in dark mode in browsers that honor media queries on icon links.
