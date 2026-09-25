---
"blume": patch
---

Rich text from a CMS source (Notion, Contentful, Sanity, Strapi, Payload) renders more faithfully. A `^` no longer turns text like "2^10 and 2^20" into superscript, `$$` no longer starts math, and a colon before a word (`10:30`, `pets:read`) stays text. Two struck-through runs side by side now render as one strikethrough instead of showing `~~~~`, and a heading that ends in " #" keeps its `#`.

A Notion page with no Slug property is now routed by its whole title, with slashes turned into hyphens: "CI/CD Setup" publishes at `ci-cd-setup` instead of at `cd-setup` in an invented `ci` group. A Slug property still sets a nested path. A Notion video URL that contains a double quote or a backslash no longer breaks the page.
