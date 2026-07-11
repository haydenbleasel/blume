---
"blume": patch
---

Changelog timeline heading links now resolve under `deployment.base`: `<Update>` routes its heading href through `withBase` at emit time, like every other link emitter, so with a base of `/docs` the headings point at `/docs/changelog/vX` instead of 404ing at `/changelog/vX`. In-page anchor fallbacks (`#id`) and external URLs pass through untouched.
