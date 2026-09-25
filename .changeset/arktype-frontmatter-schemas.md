---
"blume": patch
---

ArkType schemas now work in `frontmatter.extend` and `content.types.<type>.frontmatter`. ArkType types are callable functions, and Blume only accepted Standard Schemas that were plain objects, so config validation rejected them.
