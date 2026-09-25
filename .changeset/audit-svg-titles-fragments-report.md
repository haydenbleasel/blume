---
"blume": patch
---

`blume audit` no longer counts an inline SVG's `<title>` as a page title, so an accessible icon doesn't raise `BLUME_AUDIT_TITLE_MULTIPLE` (an error) or stand in for a missing head `<title>`. Text-fragment links (`#:~:text=…`) aren't reported as broken anchors, and only the id in front of a fragment's `:~:` has to exist. An i18n fallback copy of a page is no longer reported as an orphan, which failed `--strict`. A failing audit now delivers its whole report through a pipe; it used to exit before a long report finished writing, cutting the CI log off partway.
