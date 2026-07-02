---
"blume": patch
---

Fix `blume validate` falsely flagging relative links from index pages. A directory index (`guides/index.mdx`, route `/guides`) has a route that already _is_ its directory, but relative resolution still popped a segment, so a link like `./setup` resolved to `/setup` and was reported as a broken link. Index pages now resolve relative links against their own route.
