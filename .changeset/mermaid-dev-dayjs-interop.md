---
"blume": patch
---

Render Mermaid diagrams in `blume dev`. Mermaid statically imports dayjs as CommonJS (`dayjs/dayjs.min.js`), and in dev Vite served that dependency un-pre-bundled, so it exposed no `default` export and mermaid threw `does not provide an export named 'default'` — leaving diagrams blank (the production build already handled the interop). Mermaid now goes through Vite's dependency optimizer, which bundles dayjs with correct CommonJS interop. Because Blume's `import("mermaid")` lives inside `node_modules/blume` — a path Vite's optimizer scan doesn't crawl in a standalone install — the diagram library was never discovered on its own, so it's included explicitly via the nested `blume > mermaid` form (mermaid isn't a direct dependency of the generated project).
