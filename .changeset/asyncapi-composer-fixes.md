---
"blume": patch
---

AsyncAPI operations whose bindings are a `$ref` to `#/components/*Bindings` now resolve it. Before, the protocol read as "$ref", so a WebSocket operation got no samples and the composer said "Live sending isn't possible for $ref". Channel parameters are URL-encoded only for URL-based protocols (WebSocket, HTTP), so a Kafka or MQTT topic reads `sensors/sensor 1` rather than `sensors/sensor%201`. The message composer no longer hangs on "Connecting…" when the browser refuses a malformed WebSocket URL: it shows the error and lets you connect again.
