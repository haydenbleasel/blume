---
"blume": patch
---

Add a `syncKey` prop to `Tabs`: only groups sharing the same key switch together, so unrelated groups that happen to share a tab title stay independent. Nested tab groups now also keep their own panels instead of having them adopted by an ancestor group.
