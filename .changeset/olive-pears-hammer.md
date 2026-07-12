---
"blume": patch
---

Emit a complete Open Graph card in the page head, so crawlers and social validators stop flagging the metadata as incomplete:

- `og:url` — the page's canonical URL (rendered only when `deployment.site` is set, or a page overrides `seo.canonical`).
- `og:type` — `article` on blog posts and changelog entries, `website` everywhere else. Article pages also emit `article:published_time` and `article:modified_time`.
- `og:site_name` — the site `title`.
- `og:image:width`, `og:image:height`, `og:image:type`, and `og:image:alt` on Blume's generated OG card, so a crawler can lay it out without fetching the image. An `seo.image` you supply yourself declares none of these, since its dimensions and format are unknown.
