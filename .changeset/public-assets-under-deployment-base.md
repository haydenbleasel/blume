---
"blume": patch
---

With `deployment.base` set, root-relative images and file links in content now gain the base: `![logo](/logo.png)` renders as `/sub/logo.png` and `[spec](/spec.pdf)` (or `<Card href="/spec.pdf">`) as `/sub/spec.pdf`, where Astro serves `public/`. They used to keep the bare root path and 404 on a subpath deploy. Public files still never gain `basePath`, and neither does a redirect whose `to` names one: with `basePath: "/docs"`, a redirect to `/files/whitepaper.pdf` now lands on the file instead of `/docs/files/whitepaper.pdf`.
