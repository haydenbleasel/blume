---
"blume": patch
---

On a translated page, a relative link to a page that isn't translated yet now points at the locale's copy of that page in the `.md` mirrors, `llms-full.txt`, and MCP `get_page`, as it does on the rendered page. Before, it pointed at the default locale's page. On a site with both versions and locales, such a link now also lands on the page in the reader's own docs version on those surfaces and in `blume validate`, where it could point at an archived version's copy instead of the current one, and `blume validate` reads one that climbs into another version's or locale's folder as the rendered page does, instead of reporting it as broken. On an archived version's translated page, the rendered link to such a page now follows that page's `slug` too, as on the current version's.
