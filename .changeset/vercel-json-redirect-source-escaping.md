---
"blume": patch
---

Redirect `from` paths in the `vercel.json` a static build writes are now escaped, since Vercel reads each `source` as a pattern. A `from` like `/c++-guide` or `/what?` used to make the whole file invalid, and `/faq(old)` never matched.
