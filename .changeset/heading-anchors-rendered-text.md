---
"blume": patch
---

Heading anchors and titles now come from a heading's rendered text rather than its Markdown source, so they match the ids on the page. `## See [the docs](/x)` anchors as `#see-the-docs` (not `#see-the-docsx`), `## An _important_ note` as `#an-important-note`, and entities, code spans, inline HTML, images, reference links, footnote references (`## Setup[^note]` → `#setup1`, numbered in the page's footnote order), and smart punctuation (`A -- B` → `#a--b`) read the way the renderer reads them. `blume validate` no longer reports a correct link to such a heading as a broken anchor, `blume translate` pins the id the page actually has, Obsidian heading links land on the section, and a page without a frontmatter `title` is titled "Using Astro with Blume" instead of the raw "Using [Astro](https://astro.build) with **Blume**".
