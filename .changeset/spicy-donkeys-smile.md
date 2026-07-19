---
"blume": patch
---

Link Blume's nested integrations into the generated runtime when npm's split install hoists astro away from them. An `overrides` astro pin plus an incremental `npm install` — the exact steps the Astro-conflict warning recommends — hoists astro to the project root while `@astrojs/mdx` and Blume's other deps stay nested under `node_modules/blume/node_modules`, so fresh checkouts and `blume build --isolated` failed with `Cannot find module '@astrojs/mdx'`. The dependency link now probes for the integrations instead of astro alone and links the nested set, letting astro keep resolving from the hoisted copy.
