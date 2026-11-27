---
"blume": patch
---

Keep `deployment.base` in a build whose environment has a `BASE_URL` variable. Astro's build inlines every environment variable over the `import.meta.env` field of the same name in server code, so a `BASE_URL` meant for another app (a monorepo's root `.env`, a CI variable) took the base's place in server-rendered links and JSON-LD URLs, while links rendered in the browser kept the real one. Blume now reads the base from a build constant of its own, and the variable stays readable from your own code.
