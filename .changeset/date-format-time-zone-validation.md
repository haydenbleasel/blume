---
"blume": patch
---

An unknown `dateFormat.timeZone` (`Asia/Tokio`) is now a config error that points at the key, instead of a `RangeError` thrown later while rendering a page's "last updated" date or the changelog.
