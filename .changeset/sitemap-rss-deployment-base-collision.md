---
"blume": patch
---

The sitemap and RSS feeds now always put `deployment.base` in front of a page's URL, even when the page's route starts with the same segment. With `base: "/guides"`, a page at `guides/setup.md` is listed at `/guides/guides/setup`, where it's served, instead of `/guides/setup`.
