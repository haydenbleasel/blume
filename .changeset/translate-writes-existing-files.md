---
"blume": patch
---

`blume translate` rewrites an existing translation where it lives. A stale hand-written `fr/guide.md` for a `guide.mdx` source is updated in place instead of gaining a `fr/guide.mdx` beside it (which failed the next build with a duplicate route), a locale's hand-written `meta.js` or `meta.mjs` is rewritten instead of getting a `meta.ts` next to it, and a locale folder authored in another casing (`pt-br/` for `pt-BR`) now receives the locale's `meta.ts` too, not a second `pt-BR/` folder. A source file saved with a byte order mark keeps its frontmatter in the translation; it used to be written with the body alone. Looking for `meta.ts` titles now skips the content source's `exclude` globs and moves past a meta file that fails to load, where an application file like `src/lib/meta.ts` in a project-rooted source used to crash the run with `BLUME_INTERNAL`.
