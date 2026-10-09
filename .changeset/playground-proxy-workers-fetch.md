---
"blume": patch
---

The API reference playground's proxy (`playground: { proxy: true }`) now works on Cloudflare Workers. Before, every Try it request it forwarded to one of the spec's servers failed with a 502 "Illegal invocation" error, because the proxy called the runtime's `fetch` in a way Workers rejects and Node allows.
