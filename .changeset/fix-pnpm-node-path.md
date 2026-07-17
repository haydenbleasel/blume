---
"blume": patch
---

Fix `blume dev` under pnpm's default isolated linker. The generated runtime now checks Astro through the same physical `node_modules` ancestor lookup used by its ESM config, instead of mistaking pnpm's CommonJS-only `NODE_PATH` exposure for a resolvable `astro/config` import.
