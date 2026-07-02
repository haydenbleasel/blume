---
"blume": patch
---

Truncate OG image titles by code point instead of UTF-16 unit. A long title that was cut mid-emoji could leave a lone surrogate — a broken glyph — right before the ellipsis. Truncation now slices whole characters.
