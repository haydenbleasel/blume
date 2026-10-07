---
"blume": minor
---

Blume now requires Node.js 22.19 or newer, up from 22.12. Blume uses `undici` to send remote API spec fetches through `HTTP_PROXY` or `HTTPS_PROXY` when either is set. That dependency is now undici 8, which requires Node.js 22.19 or newer. `blume doctor` warns when the running Node.js is older than that.
