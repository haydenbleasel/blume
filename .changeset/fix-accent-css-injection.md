---
"blume": patch
---

Validate a raw `theme.accent` (and `accentDark`/`action`) before writing it into the generated theme CSS and the Scalar OpenAPI theme. A value containing CSS control characters like `;}` could otherwise break out of the declaration and inject rules; such a value now falls back to the default accent. Named presets and normal colors (hex, `rgb()`, `oklch()`, …) are unaffected.
