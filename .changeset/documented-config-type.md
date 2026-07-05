---
"blume": patch
---

Add rich per-field editor docs to `blume.config.ts`. `defineConfig` gains a comprehensive JSDoc overview, and its argument is now a hand-documented `BlumeConfig` type tree so every config field — theme, navigation, content sources, search, AI, SEO, OpenAPI, i18n, and more — shows a hover description and default value with autocomplete. A compile-time guard keeps the documented type structurally in sync with the Zod schema (still the single source of validation truth), so the two can't drift. Type-only change; runtime behavior is unchanged.
