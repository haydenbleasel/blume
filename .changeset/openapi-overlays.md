---
"blume": patch
---

Apply OpenAPI Overlays to a spec before it renders. List `overlays` beside `spec` in `openapi()` or `scalar()`, or on each source, as local paths or `http(s)` URLs, applied in order. Overlay Specification 1.0 and 1.1 are supported: `update`, `copy`, and `remove` actions, with targets as RFC 9535 JSONPath. Overlays apply to the spec as written, before it's upgraded to OpenAPI 3.1, and everything built from the spec sees the result. An overlay that fails stops its reference from rendering, the way an unreadable spec does, so it can't publish what it was meant to hide.
