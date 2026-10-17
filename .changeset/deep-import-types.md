---
"blume": patch
---

Deep imports such as `blume/core/project-graph.ts` and `blume/components/layout/locale-redirect.ts` now resolve to the shipped declarations in `dist/types` instead of Blume's `.ts` source. Before, a project that imported them type-checked that source under its own compiler options, so `exactOptionalPropertyTypes` or `noUncheckedIndexedAccess` reported hundreds of errors inside `node_modules/blume/src`, and `skipLibCheck` could not hide them.
