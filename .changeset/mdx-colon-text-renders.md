---
"blume": patch
---

Text in an `.mdx` page that reads as an inline or leaf directive now renders exactly as written. A colon followed by a letter or digit, as in `16:9`, `10:30am`, `og:image`, or `pets:read`, used to drop everything from the colon to the end of the word ("16:9 frame" rendered as "16 frame"), and a `::name[label]{attrs}` line vanished. This also covers headings and their anchors, callout titles and bodies, and API reference descriptions. `:::` callouts work as before, and `.md` pages were never affected.
