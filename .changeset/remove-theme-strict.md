---
"blume": patch
---

Remove the unused `theme.strict` config field. It validated but nothing ever read it, so it was a no-op; dropping it keeps the config surface honest. Any leftover `theme: { strict: … }` is now rejected as an unknown key.
