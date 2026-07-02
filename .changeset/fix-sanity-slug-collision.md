---
"blume": patch
---

Stop Sanity documents with non-ASCII slugs from overwriting each other. When a `slug.current` (or configured slug field) slugified to an empty string — e.g. a CJK slug — the entry fell back to a constant `untitled.md`, so multiple such documents collided on one ref and all but the last were silently dropped. The fallback now uses the document's unique `_id`, matching the Notion source.
