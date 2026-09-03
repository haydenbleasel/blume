---
"blume": patch
---

Give the API playground proxy a 30-second upstream deadline, shared across a redirect chain. The client already aborted its own request after 30 seconds, but that never reached the server-side fetch, so a documented API that accepted the connection and never answered held a server request slot until the platform killed it. A timed-out upstream is now the same JSON 502 as an unreachable one.
