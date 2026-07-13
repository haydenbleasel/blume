---
"blume": patch
---

Prerender Cloudflare adapter builds in Node so build-time `node:` imports resolve. Astro 6 changed the `@astrojs/cloudflare` default prerender runtime from Node to workerd, which broke Blume prerender on Cloudflare (`No such module "node:path"` and `node:fs` usage in Blume's build-time content tooling). The generated `astro.config.mjs` now passes `prerenderEnvironment: "node"` to the Cloudflare adapter. On-demand pages still run in workerd at request time.
