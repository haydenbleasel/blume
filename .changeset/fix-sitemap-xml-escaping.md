---
"blume": patch
---

Escape and URL-encode routes in `sitemap.xml`. A route containing an `&` (e.g. a content file named `Tips & Tricks.md`) previously emitted an unescaped `&` in `<loc>`, which is not well-formed XML — strict parsers and Google Search Console reject the entire sitemap. Routes are now percent-encoded and XML-escaped, sharing the same escaper as the RSS feed.
