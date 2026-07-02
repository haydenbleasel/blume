---
"blume": patch
---

Add `<lastmod>` to `sitemap.xml`. Pages that carry a modified date (from git or frontmatter) now emit a W3C-format `<lastmod>`, giving crawlers a recrawl signal; pages without a date are left as a plain `<url>`.
