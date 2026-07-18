---
"blume": patch
---

Add `frontmatter.extend`: opt-in custom frontmatter keys, each validated by a user-supplied schema. Page frontmatter stays strictly validated by default; a project can now declare extra keys (e.g. `owner`, `reviewedAt`) in `blume.config.ts`, mapped to schemas consumed through the Standard Schema interface — so Zod (any version the project installs), Valibot, and ArkType all work. Declared keys are validated on every page (mark them `.optional()` to relax), validated values are preserved on each page record's `custom` field, and every other key keeps the strict typo-catching behavior.
