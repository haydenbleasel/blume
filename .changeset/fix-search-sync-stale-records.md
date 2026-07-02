---
"blume": patch
---

Stop the Algolia and Typesense search syncs from leaving stale records behind. Both previously upserted keyed on the route, so a page deleted or renamed between builds stayed in the hosted index forever and surfaced as a search result that 404s. Algolia now uses `replaceAllObjects` (an atomic full replace) and Typesense drops and recreates its collection each sync, matching the Orama Cloud sync's snapshot-and-replace behavior.
