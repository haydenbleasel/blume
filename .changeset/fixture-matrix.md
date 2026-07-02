---
"blume": patch
---

Add an integration **fixture matrix** (`test/fixtures.test.ts`) that exercises
whole projects through the core pipeline — nested navigation, broken links,
invalid frontmatter (with line/column), a custom `.astro` page, a React island,
and static-vs-server feature gating — so the pieces keep working together, not
just in isolation.
