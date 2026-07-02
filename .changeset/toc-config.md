---
"blume": minor
---

Add a `toc` option to `blume.config.ts`. `toc: false` hides the on-this-page
table of contents site-wide; `toc: { minHeadingLevel, maxHeadingLevel }` changes
which heading levels it lists (default: H2–H3). Previously the range was
hardcoded and the TOC couldn't be turned off from config.
