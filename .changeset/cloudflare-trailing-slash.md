---
"blume": patch
---

On a Cloudflare server build, a content page requested with a trailing slash (`/docs/usage/`) now redirects with a `301` to its canonical URL (`/docs/usage`), keeping the query string. Before, the Worker served the page at both URLs. A request that prefers Markdown is still answered with the page's Markdown at either spelling.
