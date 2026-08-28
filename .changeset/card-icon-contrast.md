---
"blume": patch
---

Darken the typed `<Card>` icons and the stroked `<Badge>` variants that still missed the light-mode contrast bar. A card's `check`, `warning`, and `note` icons carried the same values the callout icons moved off (2.94:1, 2.95:1, and 2.68:1 against their tint) and now share the callout table. A stroked badge has no fill of its own and inherits whatever surface it sits on — inside a `note` callout, `success` at `-700` was 4.47:1 — so `success` and `warning` now take `-800` whether filled or stroked.
