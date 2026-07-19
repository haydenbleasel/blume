---
"blume": patch
---

Give each GitHub-sourced changelog release page a unique meta description derived from its release notes, instead of every release falling back to the site-wide description. The summary is the notes reduced to plain text — section headings ("### Patch Changes") and changesets' commit-hash bullet prefixes dropped, code fences and link syntax stripped — then cut at a word boundary to fit the 110–160 character search-snippet range `blume audit` checks for. It's carried as `seo.description`, so it feeds the meta/OG/Twitter description tags without adding a visible lede paragraph to the page.
