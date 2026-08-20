---
"blume": patch
---

Segment search text for every non-Latin default locale, not just Japanese, Chinese, Korean, and Thai. Orama's default tokenizer keeps only basic Latin letters and digits, so when `i18n.defaultLocale` was a Cyrillic, Greek, Hebrew, or Devanagari language the index collapsed to zero tokens and every query silently returned no hits. The script now comes from `Intl.Locale.maximize()` — `sr-Latn` keeps Orama's tokenizer while `az-Cyrl` is segmented — with legacy tags (`ja_JP.UTF-8`, `zh-cmn-Hans`) resolved by their language subtag, and Latin terms on a segmented index fold diacritics so café still matches cafe. The tokenizer follows the default locale for the whole index, so non-Latin translations on a Latin-default site are unchanged.
