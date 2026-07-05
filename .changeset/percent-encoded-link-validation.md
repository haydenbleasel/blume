---
"blume": patch
---

Percent-decode link paths and fragments before validation, so browser-copied links to non-ASCII routes and anchors (`/caf%C3%A9`, `#caf%C3%A9`) are no longer reported broken.
