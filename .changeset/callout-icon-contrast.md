---
"blume": patch
---

Darken the callout icons that miss the WCAG 1.4.11 non-text contrast bar in light mode. A callout's icon names its type, so it is meaningful UI rather than decorative: `check`/`success` and `warning` sat at 2.94:1 and 2.95:1 against their own tint and now take `-700` (4.52:1 and 4.67:1), and `note`'s icon was muted-foreground at 70% over the muted surface (2.68:1) and is now full strength (4.64:1). Dark mode was already passing.
