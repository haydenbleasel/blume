---
"blume": patch
---

Parse the project's `tsconfig.json` path aliases with the TypeScript compiler API instead of `get-tsconfig`. Blume's `get-tsconfig` v4 and Astro's pinned v5 left two copies in every install, and a stale CI `node_modules` cache could drop Astro's nested copy, failing `blume build` with `The requested module 'get-tsconfig' does not provide an export named 'readTsconfig'`. TypeScript already ships with Blume, so there is now one fewer dependency and alias resolution follows tsc exactly.
