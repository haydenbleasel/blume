---
"blume": patch
---

A `cloudflare()` server build with a `base` now writes its `_headers` rules into `dist/client/_headers`, where Cloudflare reads them, next to the adapter's own. They used to land in `dist/client/<base>/_headers`, which Cloudflare never reads and served publicly, so the Markdown and text charset, the discovery files' media types and CORS header, and the agent skills media types were dropped. The Markdown and JSON 404 answers are wired up under a base too, and a `base` written without a leading slash (`cloudflare({ base: "docs" })`) no longer stops `Accept: text/markdown` negotiation from running.
