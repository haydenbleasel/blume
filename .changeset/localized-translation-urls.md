---
"blume": minor
---

Pair translations that publish at their own localized URLs. A page can name the default-locale page it translates with `translationOf` in its frontmatter (`translationOf: guides/setup` on `fr/guides/installation.mdx`), and Blume treats the two as one page in two languages: hreflang alternates, the language switcher, and fallbacks follow the pairing instead of the route, so `/fr/guides/installation` links `/guides/setup` and no fallback copy publishes at `/fr/guides/setup`. Blume warns when a `translationOf` names no default-locale page (`BLUME_I18N_UNKNOWN_TRANSLATION`) and when two pages in one locale name the same page (`BLUME_I18N_DUPLICATE_TRANSLATION`).
