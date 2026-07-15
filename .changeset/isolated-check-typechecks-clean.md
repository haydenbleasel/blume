---
"blume": patch
---

Make the generated runtime type-check cleanly under `blume check --strict --isolated` (and any project whose `tsconfig` includes the generated files). Previously a valid site could fail with dozens of errors in the generated `.blume-verify` files:

- The raw-Markdown, RSS, and OG endpoints imported `data.json` directly, so TypeScript widened the JSON (navigation `kind` to `string`, empty arrays to `never[]`, theme mode to `string`) and rejected it against Blume's own types. They now import the typed `blume:data` virtual module.
- Endpoint handlers (`GET`, `getStaticPaths` callbacks) and the changelog/content-page helper functions had implicit-`any` parameters; they now carry explicit types.
- The OG endpoint's PNG `Buffer` is wrapped in a `Uint8Array` so it satisfies the `Response` body type, and the empty component-overrides module and the `blume:examples`/`blume:examples-theme` virtual modules now declare types.

Also stops `blume check --isolated` from reloading a running `blume dev` server: `.blume-verify` is now in Blume's ignored-directory set, so generating the isolated runtime no longer trips the content watcher.
