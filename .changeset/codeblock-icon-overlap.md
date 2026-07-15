---
"blume": patch
---

Gate the language icon on `data-language` so it no longer overlaps the first code line on header-less standalone `<CodeBlock>`s. The icon transformer runs whenever icons are on, but a standalone block without a `title` never gets `data-language` (the header bar that reserves the icon's space), so the absolutely-positioned icon sat on top of the first line. Fenced code and titled blocks are unaffected.

Fixes #56.
