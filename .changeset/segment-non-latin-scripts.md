---
"blume": patch
---

Segment search text for every non-Latin script, not just Japanese, Chinese, Korean, and Thai. Orama's default tokenizer splits on a Latin-only delimiter class, so Cyrillic, Greek, Hebrew, and Devanagari content collapsed to zero tokens and every query on it silently returned no hits. The script now comes from `Intl.Locale.maximize()`, so `sr-Latn` keeps Orama's tokenizer while `az-Cyrl` is segmented.
