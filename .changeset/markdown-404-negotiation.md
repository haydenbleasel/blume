---
"blume": patch
---

The default 404 page now has a Markdown twin at `/404.md` — the not-found message plus the same recovery links as the HTML page (every top-level section, the sitemap, and `llms.txt`), absolute once `deployment.site` is set. On a Vercel server build, a request for a missing page that sends `Accept: text/markdown`, or asks for a `.md`/`.mdx` URL no page backs, gets that Markdown body with the `404` status instead of the HTML shell, so agents recover from a stale URL without parsing page chrome. Both variants are skipped together when a project owns `/404` with its own `pages/404.astro` or a `404.md` content page.
