---
"blume": patch
---

Emit a `_headers` file for static builds so hosts serve the raw AI-ready endpoints with an explicit `charset=utf-8`. Blume's `/<route>.md`, `/<route>.mdx`, and `.txt` outputs (`llms.txt`, `llms-full.txt`) are valid UTF-8, but common static hosts serve them as `text/markdown` / `text/plain` with no charset — so browsers fall back to Windows-1252 and non-ASCII docs (Japanese, accented Latin, …) render as mojibake when the raw URL is opened directly. The new `_headers` pins the same `charset=utf-8` Content-Type the dev/server runtime already sends; Netlify and Cloudflare (Pages/Workers static assets) honor it, and hosts that ignore `_headers` (Vercel, S3) are unaffected. The globs carry any `deployment.base`/`basePath` stack, and a `_headers` you ship in `public/` is left untouched — exactly like `_redirects`.
