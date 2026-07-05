---
"blume": patch
---

Fix folder `meta.ts` being ignored and doc pages 404ing in dev when a `content.sources` filesystem source's `root`/`prefix` diverges from `content.root`. Folder meta is now discovered per filesystem source — scanned under each source's own root and keyed by its route prefix — so a `meta.ts` inside a prefixed source (e.g. `{ type: "filesystem", root: "docs", prefix: "docs" }`) lines up with its prefixed sidebar group path and its `title`/`order` apply. A project with a single filesystem source now roots the generated `docs` collection at that source's own `root`, so entry ids resolve in dev (not just in static builds). A residual mismatch that can't be reconciled — a second filesystem source rooted outside the collection base — now raises a build-time error (`BLUME_ENTRY_ID_MISMATCH`) instead of silently 404ing at runtime.
