---
"blume": patch
---

Stop `blume validate` from misreading a route with a dot in its last segment as a missing asset. A link to a real page like `/releases/v1.0` matched the asset-extension heuristic (`.0`) before the route was checked, producing a false `BLUME_BROKEN_ASSET` warning. Link validation now checks the route map first, so a real route always wins over the asset heuristic.
