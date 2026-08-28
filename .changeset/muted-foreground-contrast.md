---
"blume": patch
---

Darken `--blume-muted-foreground` from `oklch(0.54 0 0)` to `oklch(0.53 0 0)` and lighten the `tip` tint on callouts and cards from `accent/10` to `accent/6` so muted body text clears WCAG AA on every tinted surface, not just on the page. At `0.54` muted text was 5.06:1 on the background but 4.38:1 inside a `danger` callout and 4.50:1 inside an `info` one; at `0.53` those rise to 4.57:1 and 4.69:1 and the page to 5.28:1. `tip` tints with the configurable accent, whose default is near black, so no text lightness alone could make it safe — even at `0.53` it sat at 4.25:1 over the 10% tint. At 6% it clears 4.5:1 against any accent (4.62:1 worst case on pure black). Dark-mode tokens are unchanged.
