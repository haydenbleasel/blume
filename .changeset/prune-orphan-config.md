---
"blume": minor
---

Prune the orphan `blume.config.ts` fields that validated but nothing read:
`navbar`, `footer`, `icons`, `contextual`, and `styling` (Mintlify-compat
leftovers). They no longer silently no-op — setting one is now a config error, so
the surface reflects what Blume actually does. The Mintlify/Starlight migrators
stop emitting them; per-partition `chromeVariants` keep only their `banner`
override. (Site footers are available via the `Footer` layout slot, and code
icons via `markdown.code.icons`.)
