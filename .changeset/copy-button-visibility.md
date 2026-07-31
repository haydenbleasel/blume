---
"blume": patch
---

Give the code-block copy button a visible surface and cap code block height

The copy button previously rendered transparent over the code, making it hard to see against syntax-highlighted lines. It is now an opaque chip with hover states and a check icon that swaps in after copying. Code blocks taller than 24rem now scroll vertically in place (on the inner code scroller, so the header bar and copy button stay put).
