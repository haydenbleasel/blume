---
"blume": patch
---

The generated changelog index now passes the resolved UI dictionary and the default locale's lang/dir to the layout, and the generated 404 page now passes lang/dir alongside the dictionary it already used. Previously every chrome string on `/changelog` reverted to English on a non-English default locale, and both pages rendered `dir="ltr"` under an RTL default locale.
