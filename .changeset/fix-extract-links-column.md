---
"blume": patch
---

Report the correct column for a Markdown link whose label repeats its target.
The link position was found by searching for the target text from the start of
the `[label](target)` match, so `[/a/b](/a/b)` pointed at the occurrence inside
the label. The column is now taken from the `](` boundary.
