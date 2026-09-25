---
"blume": patch
---

The homepage `Link` header `blume dev` sends now lists only what the dev server serves: the JSON API's OpenAPI description and the homepage's Markdown mirror. It used to also advertise `/llms.txt`, `/agent-readability.json`, and the API and AI catalogs, which `blume build` writes and the dev server answered with 404s. Built and deployed sites send the same header as before.
