---
"blume": patch
---

Keep an explicit script subtag when a search locale carries a POSIX suffix. `az_Cyrl.UTF-8` fell back to `az`, which maximizes to Latin script, so segmentation stayed off and Cyrillic content produced no search tokens; `sr_Latn.UTF-8` did the reverse. The codeset and modifier suffix is now dropped before the tag is parsed.
