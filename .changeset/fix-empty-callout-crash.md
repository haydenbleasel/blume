---
"blume": patch
---

Fix a build crash when a callout directive is empty. An empty `:::note` / `:::` (no body) parses to a node with `children: null`, which the callout plugin spread into an array and threw on — failing the whole page build. Empty callouts now render as an empty `<Callout>` instead of crashing.
