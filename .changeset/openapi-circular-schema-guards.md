---
"blume": patch
---

Circular OpenAPI schemas no longer crash the build with a stack overflow. `typeLabel` recursed forever on arrays whose `items` `$ref` pointed back at the same schema (it resolved the ref before recursing, bypassing its own `$ref` shortcut — array-of-ref types now label as `Name[]`), and `objectProperties` followed mutually-recursive `allOf` chains with no visited-ref guard, which also took down `exampleValue` and every generated request sample. Both now terminate on any cyclic spec.
