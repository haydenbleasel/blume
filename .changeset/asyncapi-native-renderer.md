---
"blume": minor
---

Native AsyncAPI renderer. The `asyncapi` block now defaults to `renderer: "blume"` — one real page per `send`/`receive` operation, grouped by tag (or channel address) in a tab-scoped sidebar, with message payload and header schema tables, channel parameters, protocol bindings, an Authorization section derived from `securitySchemes`, protocol-aware code samples (`wscat`/`WebSocket` for ws, `kcat` for Kafka, `mosquitto_pub`/`mosquitto_sub` for MQTT), and full participation in site search, `llms.txt`, and OG images. AsyncAPI 2.x specs are normalized to 3.x automatically with the official AsyncAPI converter, so `publish`/`subscribe` map onto stable operation URLs. The `asyncapi` block gains `renderer`, `codeSamples`, and `expandSchemas` for full parity with `openapi`; per-source `includeInSearch`/`includeInLlms`/`noindex` now apply to AsyncAPI sources too.

**Behavior change:** AsyncAPI references were previously always rendered by the embedded Scalar SPA. Set `asyncapi: { renderer: "scalar" }` to keep the old behavior.
