---
"blume": patch
---

`@astrojs/vue` and `@astrojs/svelte` are now declared as optional peer dependencies, matching `@astrojs/netlify` and `@astrojs/cloudflare`. Projects using Vue or Svelte islands must install the matching integration themselves, and package managers now surface and satisfy that requirement instead of the build relying on an undeclared package.
