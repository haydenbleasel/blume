---
"blume": patch
---

`blume eject` now writes the not-found page's Markdown and JSON twins (`/404.md` and `/404.json`) beside its `404.astro`, so the ejected app answers the same missing-page URLs as the hidden runtime. Like the page itself, they're left out when the project already owns `/404` with a `pages/404.astro` or a `404.md` content page.
