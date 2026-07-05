---
"blume": patch
---

Stop entity-escaping backtick code in OpenAPI descriptions: inline code and fences like `/pets/{petId}` now render verbatim instead of showing `&#123;` entities, while surrounding prose is still MDX-neutralized.
