---
"blume": patch
---

Harden the generated **Ask AI** endpoint. `POST /api/ask` now validates the request body — a malformed or non-JSON body, or a `messages` value that isn't a 1–40 item array within a size cap, returns a `400` instead of throwing an unhandled `500`. The model call is wrapped so a streaming error returns a `500` rather than crashing the request. The message caps also bound how much a single call to this unauthenticated endpoint can spend against your model; the docs now recommend fronting it with a rate limiter.
