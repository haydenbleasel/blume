---
"blume": patch
---

Stop the `Prompt` component's copy button from shifting the layout. On copy, the button's label swapped "Copy prompt" → "Copied", and because the button was sized to its text, it shrank — giving the description beside it more room and reflowing it (a two-line description would collapse to one line, then jump back). Both labels now share a single grid cell, so the button is always sized to the wider "Copy prompt" and never resizes when the state changes.
