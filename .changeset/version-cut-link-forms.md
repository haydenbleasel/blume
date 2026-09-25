---
"blume": patch
---

`blume version` now also rewrites reference-style link definitions (`[setup]: /guides/setup`), single-quoted `href='…'` and `src='…'` attributes, and links that spell out the `basePath` (`/docs/guides/setup` becomes `/docs/v1.0/guides/setup`) inside the snapshot. Those links used to keep pointing at the current docs.
