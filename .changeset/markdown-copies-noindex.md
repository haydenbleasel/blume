---
"blume": patch
---

Keep pages' Markdown copies out of search indexes. The header rules Blume writes for Netlify, Cloudflare, and static Vercel deploys now send `X-Robots-Tag: noindex` on every `.md` and `.mdx` URL, so a copy no longer competes with its page in search results. The Cloudflare Worker strips the header when a page's own URL answers `Accept: text/markdown`.
