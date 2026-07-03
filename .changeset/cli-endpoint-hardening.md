---
"blume": patch
---

A round of CLI and generated-endpoint hardening: config validation now reports every issue in one failing run instead of one per rerun; a second concurrent `blume dev` refuses instead of silently sharing (and corrupting) `.blume/` with the first; the dev-lock liveness probe treats an `EPERM` (process alive under another user) as locked instead of stale; an explicit `/index` sidebar ref resolves to the root route instead of an empty link; the generated Mixedbread search endpoint returns an empty result for malformed JSON instead of a 500; malformed percent-encoding in an asset URL 404s instead of throwing in middleware; and a `client:media` override value with quotes or newlines can no longer break the generated wrapper component.
