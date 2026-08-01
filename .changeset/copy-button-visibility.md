---
"blume": patch
---

Give the code-block copy button a visible surface and cap code block height

The copy button previously rendered transparent over the code, making it hard to see against syntax-highlighted lines. It is now an opaque chip with hover states and a check icon that swaps in after copying. Code blocks taller than 24rem now scroll vertically in place (on the inner code scroller, so the header bar and copy button stay put), with thin theme-colored scrollbars matching the sidebar treatment and a brighter thumb in dark mode. The scroller is keyboard-focusable (the tab stop moves from the pre to the element that actually scrolls), print output renders capped blocks in full, and the Component source pane keeps its own measured height. Copy success is now announced to screen readers via a polite live region, using the existing localized "Copied!" string.
