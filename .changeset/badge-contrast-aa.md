---
"blume": patch
---

Darken the green and orange text that misses WCAG AA in light mode. Both drew at `-700` over a 15% tint of their own hue, landing at 4.32:1 and 4.44:1 against the 4.5:1 bar for text that size, while every other hue already cleared it (teal 4.69:1, red 5.17:1, blue 5.71:1, purple 5.82:1, violet 6.00:1, yellow 6.02:1). At `-800` they reach 6.20:1 and 6.25:1, with the fill weight unchanged. This covers the GET and PUT method badges (and GraphQL `QUERY`), the matching badges in a reference's sidebar, 2xx and 4xx response status chips, and `<Badge>`'s `success` and `warning` variants. The `deprecated` label on an operation moves too: at `orange-600` on the page background it was 3.59:1, the worst of the set. Dark mode was already passing and is unchanged.
