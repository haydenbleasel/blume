---
"blume": patch
---

`blume eject` no longer silently overwrites a customized root `tsconfig.json`. Eject wrote its own `tsconfig.json` unconditionally, clobbering any paths or compiler options you'd tuned, and the confirmation only mentioned `astro.config.mjs` and `src/`. It now leaves an existing `tsconfig.json` in place (writing one only when absent), and the confirmation discloses the `tsconfig.json` and `package.json` changes.
