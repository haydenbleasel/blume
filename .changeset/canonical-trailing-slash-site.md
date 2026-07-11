---
"blume": patch
---

A `deployment.site` with a trailing slash (`https://docs.example.com/`) produced double-slash canonical and `og:image` URLs on pages rendered through `PageLayout` (custom pages, the default 404). The trailing slash is now stripped before joining, matching how content pages build theirs.
