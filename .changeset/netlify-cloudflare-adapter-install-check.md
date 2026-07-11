---
"blume": patch
---

Server builds targeting Netlify or Cloudflare now warn up front when `@astrojs/netlify` or `@astrojs/cloudflare` isn't installed, naming the exact package to add. Previously the generated `astro.config.mjs` imported the adapter unconditionally — including when it was auto-selected from platform env vars — so the build died with an opaque `ERR_MODULE_NOT_FOUND` from a hidden generated file. Both adapters are now declared as optional peer dependencies so package managers surface and satisfy the requirement.
