---
"blume": patch
---

Depend on the same `get-tsconfig` release Astro pins so installs carry a single copy. Two copies (Blume's v4 hoisted, Astro's v5 nested) let a stale CI `node_modules` cache drop the nested one, and `blume build` then failed with `The requested module 'get-tsconfig' does not provide an export named 'readTsconfig'`.
