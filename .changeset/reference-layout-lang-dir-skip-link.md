---
"blume": patch
---

The Scalar API reference shell now sets `<html lang>` and `dir` from the default locale, mirroring the changelog index's locale wiring, and renders the same localized skip-to-content link as the other layouts. Previously it hardcoded `lang="en"` with no `dir` — so RTL default locales rendered LTR chrome — and offered keyboard users no way to skip past the navbar.
