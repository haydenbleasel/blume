---
"blume": patch
---

Disambiguate OpenAPI reference slugs when distinct routes slugify identically (`/api/v1` vs `/api-v1`), so one spec no longer silently overwrites the other's data in the `blume:openapi` module.
