---
"blume": patch
---

Keep a Contentful table's rows whole. Inline code with a backslash before a `|` (`grep 'a\|b'`) split its row and dropped the cells after it, and a bare URL with a `|` in it linked to an address with a stray backslash in it. The code now renders in full and the URL links where it points. A row with more cells than the first keeps them.
