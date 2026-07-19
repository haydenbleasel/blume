---
"blume": patch
---

Decouple Twoslash from the project's hoisted TypeScript so sites can use TypeScript 7 (tsgo). The generated Astro config now wires in `blumeTwoslashTransformer` from `blume/markdown`, which compiles Twoslash fences with Blume's own pinned classic TypeScript (passed explicitly as `tsModule` plus `tsLibDirectory` for the default lib files) instead of resolving whatever `typescript` the surrounding project installed — under TS7 that package's main export is a version stub with no compiler API and no `lib.*.d.ts` files, so any `twoslash` fence crashed the build.
