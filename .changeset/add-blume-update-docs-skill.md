---
"blume": patch
---

Add a `blume-update-docs` agent skill for keeping a Blume docs site in sync with the product it documents. A scheduled agent run audits recently merged PRs, changelogs, config schemas, and CLI help against the docs, updates only pages that are factually stale (feature-flagged work is ignored), verifies with `blume build`, and opens or updates a `blume/*` pull request — or reports a clean no-op. Install it with `npx skills use haydenbleasel/blume@blume-update-docs`; it also ships in the package at `node_modules/blume/skills`. The new `/docs/advanced/skills` page documents all shipped skills.
