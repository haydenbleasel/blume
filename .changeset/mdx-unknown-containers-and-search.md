---
"blume": patch
---

A `:::` block in an `.mdx` page whose name isn't a callout type, like a `:::details` carried over from another docs tool or a typo like `:::warnig`, no longer disappears along with everything inside it. Its content now renders between its `:::` lines, which stay on the page as written, and `blume dev`, `blume build`, and `blume check` warn with `BLUME_UNKNOWN_DIRECTIVE`, naming the callout types. A callout nested inside another (a `::::note` around a `:::tip`) now renders instead of vanishing. Site search now indexes text like `16:9` and `og:image` as the page shows it, instead of as "16" and "og".
