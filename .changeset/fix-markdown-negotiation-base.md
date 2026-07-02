---
"blume": patch
---

Honor a non-root `deployment.base` in the dev server's `Accept: text/markdown`
negotiation. The rewrite matched the base-prefixed request URL against the
base-less content routes, so markdown negotiation silently did nothing under a
configured `base`. The base is now stripped before matching and re-added to the
rewritten `.md` URL.
