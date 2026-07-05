---
"blume": patch
---

Always-on inline code highlighting and block math; remove their config flags. `markdown.code.inline` and `markdown.math` are gone. Inline `` `code{:lang}` `` highlighting now always runs — it only fires on the explicit `{:lang}` marker, so plain inline code is untouched and there was nothing to opt out of. Math is now always on but **block-only** (`$$…$$`): a bare `$` (currency, shell, code) is always left as literal text, which is exactly why the flag existed, so there's no longer a `$`-in-prose caveat to gate. The `<Math>` component and KaTeX's stylesheet are still only shipped when a page actually uses `$$` — now detected from content instead of a config toggle — so a math-free site pays nothing. Inline `$…$` math is no longer supported (the single-dollar delimiter is reserved for literal text).
