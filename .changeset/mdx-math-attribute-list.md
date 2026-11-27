---
"blume": patch
---

Stop reporting `BLUME_MDX_ATTRIBUTE_LIST` for braces inside `$$…$$` math in `.mdx` pages. MDX parses math before expressions, so a LaTeX subscript like `\sum_{i=1}^{n}` is no longer mistaken for an attribute list, in block or inline math.
