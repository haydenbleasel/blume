---
"blume": patch
---

Fix `blume dev`/`build` failing to resolve Astro and its integrations under isolated package-manager linkers (Bun's `isolated` mode, pnpm), which forced projects to redeclare Blume's dependencies by hand. The generated `.blume/` runtime now locates Blume's real dependency directory — whether nested under the package or installed as siblings in a virtual store — and symlinks it in, so the generated config's bare specifiers resolve without the project adding any deps. Stale or broken `.blume/node_modules` links are also detected and rebuilt.
