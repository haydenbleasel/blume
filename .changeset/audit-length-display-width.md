---
"blume": patch
---

Measure the audit's title and meta-description limits in display columns rather than characters. What a search engine truncates is the space the text takes up, and a character count only stands in for that where every character is one column wide — true of Latin text and of nothing else. Counted in characters, one range cannot serve both scripts: the same 110–160 was at once too strict for a Japanese description (which says in ~60 characters what English needs ~120 for, so every page of a Japanese site reported `BLUME_AUDIT_DESCRIPTION_LENGTH`) and too loose for a Japanese title (60 characters render as wide as 120 Latin ones and truncate, and nothing was reported). Widths come from `string-width`, so a fullwidth or wide character counts 2 and Latin text scores exactly as it did before — an English site's findings are unchanged.
