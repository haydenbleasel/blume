---
"blume": patch
---

Changelog entries whose labels slug identically (e.g. repeated titles, or several entries with neither a title nor a version) no longer render duplicate element ids: later duplicates are suffixed `-2`, `-3`, ... at build time, so each heading and TOC item deep-links to its own entry instead of the first match. The first occurrence keeps the plain slug, so existing anchors stay stable.
