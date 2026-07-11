---
"blume": patch
---

Serve image-path icons from under `deployment.base`. `<Icon>` emitted an image icon's path (`/brand/mark.png`) as-is, so on a site deployed under a base path the request went to the domain root and 404'd while `<Card img>`, the logo, and every other image emitter were correctly rebased. Image icons now get the same `withBase` treatment; external URLs, data URIs, and relative paths are untouched.
