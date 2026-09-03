---
"blume": patch
---

Corrections to the `blume-migrate` skill: a Docusaurus or Fumadocs folder with `collapsible: false` maps to that folder's `display: "flat"` instead of being dropped, several Fumadocs GraphQL sources map to `graphql.sources` rather than a single `spec`, a Nextra `docsRepositoryBase` on a non-`github.com` origin sets `github.host` to that origin, and the favicon convention reads `icon.{svg,png,ico}` or `favicon.{svg,png,ico}`.
