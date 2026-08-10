---
"blume": patch
---

Keep punctuation out of the index terms the segmenting search tokenizer produces. `Intl.Segmenter` follows UAX #29, which holds connector punctuation, combining marks, format characters and mid-number punctuation *inside* a word, so `スネーク_ケース`, `1,000` and `robots.txt` each arrived as a single word-like segment and were indexed as they stood — reachable only by retyping the punctuation, and unreachable from `ケース` or `txt`. Word-like segments made of nothing but a symbol became index terms of their own. Segments are now split on anything that is neither a letter nor a digit, and that boundary ends a bigram run the same way a space or an interpunct does, so no window spans it.
