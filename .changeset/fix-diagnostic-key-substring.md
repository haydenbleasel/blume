---
"blume": patch
---

Anchor config/frontmatter diagnostic positions to whole keys. When locating a Zod issue in the source, a path segment like `title` could match the tail of an unrelated key such as `subtitle:`, pointing the error at the wrong line/column. Key matching now requires a word boundary.
