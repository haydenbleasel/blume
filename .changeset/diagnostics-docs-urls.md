---
"blume": patch
---

Diagnostics now carry a `docsUrl` pointing at the page that explains them. Every
mapped error/warning (config, frontmatter, meta, sources, links, deployment, …)
prints a `docs: https://useblume.dev/docs/…` line, so a failing build links
straight to the fix.
