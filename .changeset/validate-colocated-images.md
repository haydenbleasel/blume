---
"blume": patch
---

Stop `blume validate` reporting colocated images as broken assets. A relative image reference (`![](./diagram.png)`) — the form the docs recommend for local images, since those are optimized at build time — was resolved into a site route and then looked for under `public/`, where it never lands: the image pipeline emits it to `_astro/` from beside the content. Every such reference came back as `BLUME_BROKEN_ASSET`, so `--strict` failed on a site whose pages render the image correctly. Validation now accepts a relative image that exists next to its page source, using the same resolver that decides which colocated images the `/blume-assets/content` endpoint serves, so the two can't disagree about what one is. A relative reference that resolves nowhere is still reported.
