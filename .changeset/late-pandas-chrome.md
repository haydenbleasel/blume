---
"blume": patch
---

Backfill every built-in UI language pack with the chrome strings added since launch — the Export menu, "Copy code", "Copy Codex command", the Ask AI panel, navigation and theme-toggle labels, the 404 page, and the newer search dialog strings — so localized sites no longer show English for those surfaces. The "Open in v0/ChatGPT/Claude/…" provider labels, previously hardcoded, now localize through a new `actions.openIn` template (`"Open in {name}"`).
