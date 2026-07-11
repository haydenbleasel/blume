---
"blume": patch
---

Reject a `toc` config whose `minHeadingLevel` exceeds its `maxHeadingLevel`. An inverted range (including an explicit min above the default max of 3) previously validated fine and silently rendered an empty table of contents on every page; it now fails config validation with a clear message.
