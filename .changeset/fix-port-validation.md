---
"blume": patch
---

Validate `--port` on `blume dev` and `blume preview`. A non-numeric value (`--port abc`) became `NaN`, which then flowed into `http://localhost:NaN` as the dev server's `deployment.site` fallback — corrupting canonical URLs, OG image links, and the sitemap fallback. An invalid or out-of-range port now errors out instead.
