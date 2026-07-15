---
"blume": patch
---

Introduce the `blume-migrate` agent skill. It teaches an AI agent to migrate an existing docs site — Mintlify, Docusaurus, Fumadocs, Nextra, Starlight, or any docs framework — into an idiomatic Blume project: translating the source config to `blume.config.ts`, restructuring content into filesystem-derived navigation (with `redirects` for every moved route), rewriting callouts to `:::` directives, converting icons to Lucide, inlining snippets, and pointing generated API references at `openapi.sources` instead of porting endpoint stubs. Ships with per-framework mapping references, a deterministic Mintlify codemod for the icon/frontmatter pass, and monorepo/Vercel integration recipes. The skill is bundled in the package under `skills/`.
