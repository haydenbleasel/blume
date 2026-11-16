---
"blume": patch
---

OpenAPI schema tables and generated examples now keep the JSON Schema constraints they used to drop. A `oneOf` or `anyOf` variant that only lists `required` names now shows those properties as required, where the variant used to read as `any`. The heading says "Exactly one of" for `oneOf` and "At least one of" for `anyOf`, and a schema with both shows both. A map (`additionalProperties`) is labeled `map<string, T>`, with its values as a `[key: string]` row. Enum values render as JSON, so `""` is visible and `null` differs from `"null"`, and a `not` reads as `not "reserved"`. A `required` or other keyword beside a `$ref` adds to the referenced schema instead of replacing it, and a property that several `allOf` members constrain keeps every constraint.

Generated request and response examples are now checked against their schema, including `oneOf`, `anyOf`, `not`, `const`, numeric and length bounds, and map values. A sample that fails is retried with each `oneOf` narrowed to its first variant, then without the schema's own `example` values. If no sample passes, Blume shows no example rather than an invalid one, and request snippets and the Try it prefill send no body. The Try it validator applies the same checks. A schema that allows only `null` now shows `null` as its example instead of no example.
