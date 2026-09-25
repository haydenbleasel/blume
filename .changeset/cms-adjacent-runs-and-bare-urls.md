---
"blume": patch
---

Rich text from a CMS source (Notion, Contentful, Sanity, Strapi, Payload) renders neighboring runs with the same formatting as one: two bold runs side by side used to show `****` between them, and two italic runs `**`. Neighboring runs under the same link in Notion and Sanity now form one link. A bare URL containing `_`, `~`, or `*` stays a working link instead of gaining backslashes in its address, and struck-through text in a Contentful table cell no longer shows `~~~~`.
