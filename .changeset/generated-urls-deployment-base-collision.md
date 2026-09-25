---
"blume": patch
---

Every URL Blume generates for a page now puts `deployment.base` in front, even when the page's route starts with the same segment. With `base: "/guides"`, a page at `guides/setup.md` is served at `/guides/guides/setup`, but its canonical URL, sidebar and tab links, breadcrumbs, previous/next links, search results, JSON-LD, `llms.txt` and `llms-full.txt` entries, JSON API and MCP URLs, and relative links to it (`./setup`) all pointed at `/guides/setup`. They now point where the page is served. A root-relative link you write that already starts with the base is still left as written. The language switcher's links to locales a page has no translation for get the same fix for `basePath`.
