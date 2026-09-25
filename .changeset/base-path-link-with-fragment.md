---
"blume": patch
---

A link that already carries `basePath` followed by a fragment or query, like `[Install](/docs#install)` under `basePath: "/docs"`, is no longer prefixed a second time. It used to render as `/docs/docs#install`, a 404 the link checker didn't catch.
